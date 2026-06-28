import pool from '../config/database.js';
import logger from '../../utils/logger.js';
import { redisGet, redisSet } from './redis.service.js';
import { getProjectScope } from './forecast.service.js';

const CACHE_KEY_PREFIX = 'dashboard:search';
const CACHE_TTL = 60; // 1 minute (short cache for dynamic suggestions)

/**
 * Fetch search suggestions based on prefix/partial matching and entity type.
 *
 * @param {string} q
 * @param {string} type
 * @param {string|number} [projectId]
 * @param {number} [limit]
 * @returns {Promise<Array<string>>}
 */
export async function getDashboardSearchSuggestions(q, type = 'all', projectId = null, limit = 8) {
  const qClean = String(q || '').trim();
  if (qClean.length < 2) {
    return [];
  }
  const qLower = qClean.toLowerCase();

  // Build cache key
  const cacheKey = `${CACHE_KEY_PREFIX}:${type}:${projectId || 'all'}:${qLower}:${limit}`;

  try {
    const cached = await redisGet(cacheKey);
    if (cached) {
      logger.info(`[Redis] Search suggestions cache hit for key: ${cacheKey}`);
      return JSON.parse(cached);
    }
  } catch (err) {
    logger.warn('Failed to retrieve search suggestions from Redis, fallback to DB:', err?.message || err);
  }

  const client = await pool.connect();

  try {
    const params = [];
    let scopeConditionSql = 'TRUE';

    // 1. Resolve project scope if projectId is provided
    if (projectId) {
      let scope;
      try {
        scope = await getProjectScope(client, projectId);
      } catch (err) {
        if (err.code === 404) {
          err.message = 'Project not found';
        }
        throw err;
      }

      const scopeConditions = [];
      if (scope.subjectCategoryIds.length > 0) {
        params.push(scope.subjectCategoryIds);
        const catIndex = params.length;
        scopeConditions.push(`
          (
            a.primary_topic IN (
              SELECT topic_id FROM "Topic" primary_topic
              WHERE primary_topic.subject_category_id = ANY($${catIndex}::bigint[])
            )
            OR EXISTS (
              SELECT 1 FROM "Sub_Topic" st
              JOIN "Topic" sub_topic ON st.topic_id = sub_topic.topic_id
              WHERE st.article_id = a.article_id
                AND sub_topic.subject_category_id = ANY($${catIndex}::bigint[])
            )
          )
        `);
      }

      if (scope.keywordIds.length > 0) {
        params.push(scope.keywordIds);
        const kwIndex = params.length;
        scopeConditions.push(`
          EXISTS (
            SELECT 1 FROM "Keyword_Article" ka
            WHERE ka.article_id = a.article_id
              AND ka.keyword_id = ANY($${kwIndex}::bigint[])
          )
        `);
      }

      if (scopeConditions.length > 0) {
        scopeConditionSql = `(${scopeConditions.join(' OR ')})`;
      } else {
        scopeConditionSql = 'FALSE'; // If project has empty scope, search will return nothing
      }
    }

    // 2. Append search parameters
    params.push(`%${qLower}%`);
    const queryIndex = params.length;
    params.push(limit);
    const limitIndex = params.length;

    // 3. Define SQL queries for each entity type
    const queries = {
      article: `
        SELECT DISTINCT a.title AS name
        FROM "Article" a
        WHERE COALESCE(a.is_deleted, false) = false
          AND LOWER(a.title) LIKE $${queryIndex}
          ${projectId ? `AND ${scopeConditionSql}` : ''}
        LIMIT $${limitIndex}
      `,
      journal: `
        SELECT DISTINCT j.display_name AS name
        FROM "Journal" j
        ${projectId ? `
          JOIN "Volume" v ON j.journal_id = v.journal_id
          JOIN "Issue" iss ON v.volume_id = iss.volume_id
          JOIN "Article" a ON iss.issue_id = a.issue_id
        ` : ''}
        WHERE COALESCE(j.is_deleted, false) = false
          AND LOWER(j.display_name) LIKE $${queryIndex}
          ${projectId ? `AND COALESCE(a.is_deleted, false) = false AND ${scopeConditionSql}` : ''}
        LIMIT $${limitIndex}
      `,
      author: `
        SELECT DISTINCT au.display_name AS name
        FROM "Author" au
        ${projectId ? `
          JOIN "Author_Article" aa ON au.author_id = aa.author_id
          JOIN "Article" a ON aa.article_id = a.article_id
        ` : ''}
        WHERE COALESCE(au.is_deleted, false) = false
          AND LOWER(au.display_name) LIKE $${queryIndex}
          ${projectId ? `AND COALESCE(a.is_deleted, false) = false AND ${scopeConditionSql}` : ''}
        LIMIT $${limitIndex}
      `,
      institution: `
        SELECT DISTINCT i.display_name AS name
        FROM "Institution" i
        ${projectId ? `
          JOIN "Institution_Author" ia ON i.institution_id = ia.institution_id
          JOIN "Author_Article" aa ON ia.author_id = aa.author_id
          JOIN "Article" a ON aa.article_id = a.article_id
        ` : ''}
        WHERE COALESCE(i.is_deleted, false) = false
          AND LOWER(i.display_name) LIKE $${queryIndex}
          ${projectId ? `AND COALESCE(a.is_deleted, false) = false AND ${scopeConditionSql}` : ''}
        LIMIT $${limitIndex}
      `,
      keyword: `
        SELECT DISTINCT k.display_name AS name
        FROM "Keyword" k
        ${projectId ? `
          JOIN "Keyword_Article" ka ON k.keyword_id = ka.keyword_id
          JOIN "Article" a ON ka.article_id = a.article_id
        ` : ''}
        WHERE LOWER(k.display_name) LIKE $${queryIndex}
          ${projectId ? `AND COALESCE(a.is_deleted, false) = false AND ${scopeConditionSql}` : ''}
        LIMIT $${limitIndex}
      `,
      topic: `
        SELECT DISTINCT t.display_name AS name
        FROM "Topic" t
        ${projectId ? `
          JOIN "Article" a ON (a.primary_topic = t.topic_id OR EXISTS (
            SELECT 1 FROM "Sub_Topic" st WHERE st.article_id = a.article_id AND st.topic_id = t.topic_id
          ))
        ` : ''}
        WHERE COALESCE(t.is_deleted, false) = false
          AND LOWER(t.display_name) LIKE $${queryIndex}
          ${projectId ? `AND COALESCE(a.is_deleted, false) = false AND ${scopeConditionSql}` : ''}
        LIMIT $${limitIndex}
      `
    };

    // 4. Run queries depending on search type
    let rawSuggestions = [];

    if (type === 'all') {
      const allPromises = Object.keys(queries).map(async key => {
        try {
          const res = await client.query(queries[key], params);
          return res.rows.map(r => r.name);
        } catch (queryErr) {
          logger.error(`Error querying suggestions for type ${key}:`, queryErr);
          return [];
        }
      });
      const results = await Promise.all(allPromises);
      rawSuggestions = results.flat();
    } else {
      const sql = queries[type];
      if (sql) {
        const res = await client.query(sql, params);
        rawSuggestions = res.rows.map(r => r.name);
      }
    }

    // 5. Deduplicate suggestions case-insensitively
    const map = new Map();
    for (const s of rawSuggestions) {
      const trimmed = String(s || '').trim();
      if (!trimmed) continue;
      const lower = trimmed.toLowerCase();
      if (!map.has(lower)) {
        map.set(lower, trimmed);
      }
    }
    const uniqueSuggestions = [...map.values()];

    // 6. Sort: prefix match first, then contains match, then alphabetical
    uniqueSuggestions.sort((a, b) => {
      const aLower = a.toLowerCase();
      const bLower = b.toLowerCase();
      const aPrefix = aLower.startsWith(qLower);
      const bPrefix = bLower.startsWith(qLower);

      if (aPrefix && !bPrefix) return -1;
      if (!aPrefix && bPrefix) return 1;

      return a.localeCompare(b);
    });

    const finalizedData = uniqueSuggestions.slice(0, limit);

    // Save to Redis cache
    try {
      await redisSet(cacheKey, JSON.stringify(finalizedData), CACHE_TTL);
      logger.info(`[Redis] Search suggestions cached for key: ${cacheKey}`);
    } catch (cacheErr) {
      logger.warn('Failed to save search suggestions to Redis:', cacheErr?.message || cacheErr);
    }

    return finalizedData;

  } finally {
    client.release();
  }
}
