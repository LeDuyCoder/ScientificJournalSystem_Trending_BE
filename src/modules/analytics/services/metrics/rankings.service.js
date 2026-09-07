import pool from '../../../../config/database.js';
import logger from '../../../../utils/logger.js';
import { redisGet, redisSet } from '../../../core/services/infrastructure/redis.service.js';
import { getProjectScope } from '../trends/forecast.service.js';

const CACHE_KEY_PREFIX = 'analytics:rankings';
const CACHE_TTL = 43200; // 12 hours // 5 minutes

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
  let minScore = Infinity;
  let maxScore = -Infinity;
  for (const score of rawScores) {
    if (score < minScore) minScore = score;
    if (score > maxScore) maxScore = score;
  }

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

    const cteParts = [];
    const params = [];
    
    // 1. Project Scope topics / keywords
    if (scope.subjectCategoryIds.length > 0 || scope.keywordIds.length > 0) {
      params.push(projectId);
      cteParts.push(`project_articles AS (SELECT article_id FROM "Project_Article_Scope" WHERE project_id = $${params.length})`);
    }

    // 2. Custom Subject Area Filter
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
      const filterCatIdx = params.length;
      cteParts.push(`filter_sa_articles AS (
        SELECT a.article_id
        FROM "Article" a
        JOIN "Topic" t ON a.primary_topic = t.topic_id
        WHERE t.subject_category_id = ANY($${filterCatIdx}::bigint[]) AND COALESCE(a.is_deleted, false) = false
        UNION
        SELECT st.article_id
        FROM "Sub_Topic" st
        JOIN "Topic" t ON st.topic_id = t.topic_id
        WHERE t.subject_category_id = ANY($${filterCatIdx}::bigint[])
      )`);
    }

    // 3. Custom Keyword Filter
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
      const filterKwIdx = params.length;
      cteParts.push(`filter_kw_articles AS (
        SELECT article_id
        FROM "Keyword_Article"
        WHERE keyword_id = ANY($${filterKwIdx}::bigint[])
      )`);
    }

    // Year range filters
    const yearFilters = [];
    if (fromYear !== undefined && fromYear !== null) {
      params.push(Number(fromYear));
      yearFilters.push(`a.publication_year >= $${params.length}`);
    }
    if (toYear !== undefined && toYear !== null) {
      params.push(Number(toYear));
      yearFilters.push(`a.publication_year <= $${params.length}`);
    }
    const yearSql = yearFilters.length > 0 ? `AND ${yearFilters.join(' AND ')}` : '';

    // Join them all to form `filtered_articles`
    const joins = [];
    if (scope.subjectCategoryIds.length > 0 || scope.keywordIds.length > 0) {
      joins.push(`JOIN project_articles pa ON a.article_id = pa.article_id`);
    }
    if (subjectArea) {
      joins.push(`JOIN filter_sa_articles fsa ON a.article_id = fsa.article_id`);
    }
    if (keywordList.length > 0) {
      joins.push(`JOIN filter_kw_articles fkw ON a.article_id = fkw.article_id`);
    }

    cteParts.push(`filtered_articles AS (
      SELECT a.article_id, a.citation_count
      FROM "Article" a
      ${joins.join('\n      ')}
      WHERE COALESCE(a.is_deleted, false) = false
        ${yearSql}
    )`);

    const cteSql = `WITH ${cteParts.join(',\n')}`;

    // 2. Fetch and calculate Author metrics
    const authorQuery = `
      ${cteSql}
      SELECT
        au.display_name AS name,
        COUNT(DISTINCT a.article_id)::integer AS article_count,
        COALESCE(SUM(a.citation_count), 0)::integer AS citation_count,
        COALESCE(au.h_index, 0)::integer AS h_index
      FROM "Author" au
      JOIN "Author_Article" aa ON au.author_id = aa.author_id
      JOIN filtered_articles a ON aa.article_id = a.article_id
      WHERE COALESCE(au.is_deleted, false) = false
        AND au.display_name IS NOT NULL
        AND au.display_name != ''
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
      ${cteSql},
      UniqueInstArticles AS (
        SELECT DISTINCT
          i.institution_id,
          i.display_name AS name,
          a.article_id,
          a.citation_count
        FROM "Institution" i
        JOIN "Institution_Author" ia ON i.institution_id = ia.institution_id
        JOIN "Author_Article" aa ON ia.author_id = aa.author_id
        JOIN filtered_articles a ON aa.article_id = a.article_id
        WHERE COALESCE(i.is_deleted, false) = false
          AND i.display_name IS NOT NULL
          AND i.display_name != ''
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
