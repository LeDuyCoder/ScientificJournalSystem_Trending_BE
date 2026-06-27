import pool from '../config/database.js';
import logger from '../../utils/logger.js';
import { redisGet, redisSet } from './redis.service.js';
import { getProjectScope } from './forecast.service.js';

const CACHE_KEY_PREFIX = 'analytics:rankings';
const CACHE_TTL = 300; // 5 minutes

/**
 * Normalizes an array of items containing rawScore.
 * Scales scores to 0-100 range.
 * If all scores are equal, returns 100 if score > 0, otherwise 0.
 *
 * @param {Array<object>} items
 * @returns {Array<object>}
 */
function normalizeScores(items) {
  if (items.length === 0) return [];

  const rawScores = items.map(item => item.rawScore);
  const minScore = Math.min(...rawScores);
  const maxScore = Math.max(...rawScores);

  if (maxScore === minScore) {
    const scoreVal = maxScore > 0 ? 100 : 0;
    return items.map(item => ({
      ...item,
      score: scoreVal
    }));
  }

  return items.map(item => {
    const normalized = ((item.rawScore - minScore) / (maxScore - minScore)) * 100;
    return {
      ...item,
      score: Math.round(normalized * 10) / 10 // Rounded to 1 decimal place
    };
  });
}

/**
 * Assigns rankings (1, 2, 3...) based on sorted scores and filters out invalid names/scores.
 *
 * @param {Array<object>} items
 * @param {number} limit
 * @returns {Array<object>}
 */
function processRankings(items, limit) {
  return items
    .filter(item => {
      return (
        item.name !== null &&
        item.name !== undefined &&
        String(item.name).trim() !== '' &&
        item.score !== null &&
        item.score !== undefined &&
        !Number.isNaN(item.score)
      );
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item, idx) => ({
      rank: idx + 1,
      name: String(item.name).trim(),
      score: item.score,
      metric: item.metric
    }));
}

/**
 * Get influential rankings (authors and institutions) for a project.
 *
 * @param {string|number} projectId
 * @param {object} filters
 * @param {string} [filters.subjectArea]
 * @param {string|string[]} [filters.keywords]
 * @param {number} [filters.fromYear]
 * @param {number} [filters.toYear]
 * @param {number} [filters.limit]
 * @returns {Promise<object>}
 */
export async function getInfluentialRankings(projectId, filters = {}) {
  const { subjectArea, keywords, fromYear, toYear } = filters;
  const limit = filters.limit ? Number(filters.limit) : 5;

  // Process keywords into a clean sorted string to form a stable cache key
  let normalizedKeywords = '';
  let keywordList = [];
  if (keywords) {
    keywordList = Array.isArray(keywords)
      ? keywords
      : String(keywords).split(',').map(s => s.trim()).filter(Boolean);
    normalizedKeywords = [...keywordList].map(s => s.toLowerCase()).sort().join(',');
  }

  // Build cache key
  const cacheKey = `${CACHE_KEY_PREFIX}:${projectId}:${(subjectArea || '').toLowerCase()}:${normalizedKeywords}:${fromYear || ''}:${toYear || ''}:${limit}`;

  try {
    const cached = await redisGet(cacheKey);
    if (cached) {
      logger.info(`[Redis] Rankings cache hit for key: ${cacheKey}`);
      return JSON.parse(cached);
    }
  } catch (err) {
    logger.warn('Failed to retrieve rankings cache from Redis, fallback to DB:', err?.message || err);
  }

  const client = await pool.connect();
  const defaultResponse = {
    authors: [],
    institutions: []
  };

  try {
    // 1. Get project scope
    // getProjectScope will throw a 404 error if project is not found.
    const scope = await getProjectScope(client, projectId);

    if (scope.subjectCategoryIds.length === 0 && scope.keywordIds.length === 0) {
      logger.info(`Project ${projectId} has no tracking scope. Returning empty rankings.`);
      return defaultResponse;
    }

    const params = [];
    const sqlFilters = [];

    // Project scope filters: categories OR keywords
    const scopeConditions = [];
    if (scope.subjectCategoryIds.length > 0) {
      params.push(scope.subjectCategoryIds);
      const catIndex = params.length;
      scopeConditions.push(`
        (
          EXISTS (
            SELECT 1 FROM "Topic" primary_topic
            WHERE primary_topic.topic_id = a.primary_topic
              AND primary_topic.subject_category_id = ANY($${catIndex}::bigint[])
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
      sqlFilters.push(`(${scopeConditions.join(' OR ')})`);
    }

    // Client filter: subject_area
    if (subjectArea) {
      const saRes = await client.query(
        `SELECT subject_area_id FROM "Subject_Area" WHERE LOWER(display_name) = LOWER($1) AND COALESCE(is_deleted, false) = false`,
        [subjectArea.trim()]
      );

      if (saRes.rows.length === 0) {
        logger.info(`Subject area filter '${subjectArea}' not found. Returning empty rankings.`);
        return defaultResponse;
      }

      const saId = saRes.rows[0].subject_area_id;

      const scRes = await client.query(
        `SELECT subject_category_id FROM "Subject_Category" WHERE subject_area_id = $1 AND COALESCE(is_deleted, false) = false`,
        [saId]
      );
      const filterCategoryIds = scRes.rows.map(r => Number(r.subject_category_id));

      if (filterCategoryIds.length === 0) {
        logger.info(`Subject area filter '${subjectArea}' has no categories. Returning empty rankings.`);
        return defaultResponse;
      }

      params.push(filterCategoryIds);
      const filterCatIndex = params.length;
      sqlFilters.push(`
        (
          EXISTS (
            SELECT 1 FROM "Topic" ft
            WHERE ft.topic_id = a.primary_topic
              AND ft.subject_category_id = ANY($${filterCatIndex}::bigint[])
          )
          OR EXISTS (
            SELECT 1 FROM "Sub_Topic" fst
            JOIN "Topic" fst_topic ON fst.topic_id = fst_topic.topic_id
            WHERE fst.article_id = a.article_id
              AND fst_topic.subject_category_id = ANY($${filterCatIndex}::bigint[])
          )
        )
      `);
    }

    // Client filter: keywords
    if (keywordList.length > 0) {
      const kwRes = await client.query(
        `SELECT keyword_id FROM "Keyword" WHERE LOWER(display_name) = ANY($1::text[])`,
        [keywordList.map(s => s.toLowerCase())]
      );
      const filterKeywordIds = kwRes.rows.map(r => Number(r.keyword_id));

      if (filterKeywordIds.length === 0) {
        logger.info(`None of the keywords in filter matched. Returning empty rankings.`);
        return defaultResponse;
      }

      params.push(filterKeywordIds);
      const filterKwIndex = params.length;
      sqlFilters.push(`
        EXISTS (
          SELECT 1 FROM "Keyword_Article" fka
          WHERE fka.article_id = a.article_id
            AND fka.keyword_id = ANY($${filterKwIndex}::bigint[])
        )
      `);
    }

    // Client filter: year range
    if (fromYear !== undefined && fromYear !== null) {
      params.push(Number(fromYear));
      sqlFilters.push(`a.publication_year >= $${params.length}`);
    }
    if (toYear !== undefined && toYear !== null) {
      params.push(Number(toYear));
      sqlFilters.push(`a.publication_year <= $${params.length}`);
    }

    const whereClause = sqlFilters.length > 0 ? `AND ${sqlFilters.join(' AND ')}` : '';

    // 2. Fetch and calculate Author metrics
    const authorQuery = `
      SELECT
        au.display_name AS name,
        COUNT(DISTINCT a.article_id)::integer AS article_count,
        COALESCE(SUM(a.citation_count), 0)::integer AS citation_count,
        COALESCE(au.h_index, 0)::integer AS h_index
      FROM "Author" au
      JOIN "Author_Article" aa ON au.author_id = aa.author_id
      JOIN "Article" a ON aa.article_id = a.article_id
      WHERE COALESCE(a.is_deleted, false) = false
        AND COALESCE(au.is_deleted, false) = false
        AND au.display_name IS NOT NULL
        AND au.display_name != ''
        ${whereClause}
      GROUP BY au.author_id, au.display_name, au.h_index
    `;

    const authorsRes = await client.query(authorQuery, params);

    const authorsRaw = authorsRes.rows.map(row => ({
      name: row.name,
      rawScore: row.article_count * 0.3 + row.citation_count * 0.5 + row.h_index * 0.2,
      metric: 'Impact Score'
    }));

    const authorsNormalized = normalizeScores(authorsRaw);
    const authorsFinal = processRankings(authorsNormalized, limit);

    // 3. Fetch and calculate Institution metrics
    const institutionQuery = `
      WITH UniqueInstArticles AS (
        SELECT DISTINCT
          i.institution_id,
          i.display_name AS name,
          a.article_id,
          a.citation_count
        FROM "Institution" i
        JOIN "Institution_Author" ia ON i.institution_id = ia.institution_id
        JOIN "Author_Article" aa ON ia.author_id = aa.author_id
        JOIN "Article" a ON aa.article_id = a.article_id
        WHERE COALESCE(a.is_deleted, false) = false
          AND COALESCE(i.is_deleted, false) = false
          AND i.display_name IS NOT NULL
          AND i.display_name != ''
          ${whereClause}
      )
      SELECT
        name,
        COUNT(article_id)::integer AS article_count,
        SUM(citation_count)::integer AS citation_count
      FROM UniqueInstArticles
      GROUP BY institution_id, name
    `;

    const institutionsRes = await client.query(institutionQuery, params);

    const institutionsRaw = institutionsRes.rows.map(row => ({
      name: row.name,
      rawScore: row.article_count * 0.4 + row.citation_count * 0.6,
      metric: 'Citations'
    }));

    const institutionsNormalized = normalizeScores(institutionsRaw);
    const institutionsFinal = processRankings(institutionsNormalized, limit);

    const finalizedData = {
      authors: authorsFinal,
      institutions: institutionsFinal
    };

    // Save to Redis cache
    try {
      await redisSet(cacheKey, JSON.stringify(finalizedData), CACHE_TTL);
      logger.info(`[Redis] Rankings cached for key: ${cacheKey}`);
    } catch (cacheErr) {
      logger.warn('Failed to save rankings to Redis:', cacheErr?.message || cacheErr);
    }

    return finalizedData;

  } finally {
    client.release();
  }
}
