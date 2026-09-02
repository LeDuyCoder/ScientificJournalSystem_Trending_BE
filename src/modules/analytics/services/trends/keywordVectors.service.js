import pool from '../../../../config/database.js';
import logger from '../../../../utils/logger.js';
import { redisGet, redisSet } from '../../../core/services/infrastructure/redis.service.js';
import { getProjectScope } from '../trends/forecast.service.js';

const CACHE_KEY_PREFIX = 'analytics:keywords:vectors';
const CACHE_TTL = 43200; // 12 hours // 5 minutes

/**
 * Fetch keyword growth and volume vectors for a project.
 *
 * @param {string|number} projectId
 * @param {object} filters
 * @param {string} [filters.subjectArea]
 * @param {string|string[]} [filters.keywords]
 * @param {number} [filters.fromYear]
 * @param {number} [filters.toYear]
 * @param {number} [filters.windowMonths]
 * @param {number} [filters.limit]
 * @returns {Promise<Array<object>>}
 */
export async function getKeywordVectors(projectId, filters = {}) {
  const { subjectArea, keywords, fromYear, toYear } = filters;
  const limit = filters.limit ? Number(filters.limit) : 10;
  const windowMonths = filters.windowMonths ? Number(filters.windowMonths) : 12;

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
  const cacheKey = `${CACHE_KEY_PREFIX}:${projectId}:${(subjectArea || '').toLowerCase()}:${normalizedKeywords}:${fromYear || ''}:${toYear || ''}:${windowMonths}:${limit}`;

  try {
    const cached = await redisGet(cacheKey);
    if (cached) {
      logger.info(`[Redis] Keyword vectors cache hit for key: ${cacheKey}`);
      return JSON.parse(cached);
    }
  } catch (err) {
    logger.warn('Failed to retrieve keyword vectors from Redis, fallback to DB:', err?.message || err);
  }

  const client = await pool.connect();
  const defaultResponse = [];

  try {
    // 1. Get project scope
    const scope = await getProjectScope(client, projectId);

    if (scope.subjectCategoryIds.length === 0 && scope.keywordIds.length === 0) {
      logger.info(`Project ${projectId} has no tracking scope. Returning empty keyword vectors.`);
      return defaultResponse;
    }

    const cteParts = [];
    const params = [];

    // 1. Project Scope topics / keywords
    if (scope.subjectCategoryIds.length > 0 || scope.keywordIds.length > 0) {
      const scopeSelects = [];
      if (scope.subjectCategoryIds.length > 0) {
        params.push(scope.subjectCategoryIds);
        const catIdx = params.length;
        scopeSelects.push(`
          SELECT a.article_id
          FROM "Article" a
          JOIN "Topic" t ON a.primary_topic = t.topic_id
          WHERE t.subject_category_id = ANY($${catIdx}::bigint[]) AND COALESCE(a.is_deleted, false) = false
          UNION
          SELECT st.article_id
          FROM "Sub_Topic" st
          JOIN "Topic" t ON st.topic_id = t.topic_id
          WHERE t.subject_category_id = ANY($${catIdx}::bigint[])
        `);
      }
      if (scope.keywordIds.length > 0) {
        params.push(scope.keywordIds);
        const kwIdx = params.length;
        scopeSelects.push(`
          SELECT article_id
          FROM "Keyword_Article"
          WHERE keyword_id = ANY($${kwIdx}::bigint[])
        `);
      }
      cteParts.push(`project_scope AS (${scopeSelects.join(' UNION ')})`);
    }

    // 2. Client filter: subject_area
    if (subjectArea) {
      const saRes = await client.query(
        `SELECT subject_area_id FROM "Subject_Area" WHERE LOWER(display_name) = LOWER($1) AND COALESCE(is_deleted, false) = false`,
        [subjectArea.trim()]
      );

      if (saRes.rows.length === 0) {
        logger.info(`Subject area filter '${subjectArea}' not found. Returning empty keyword vectors.`);
        return defaultResponse;
      }

      const saId = saRes.rows[0].subject_area_id;

      const scRes = await client.query(
        `SELECT subject_category_id FROM "Subject_Category" WHERE subject_area_id = $1 AND COALESCE(is_deleted, false) = false`,
        [saId]
      );
      const filterCategoryIds = scRes.rows.map(r => Number(r.subject_category_id));

      if (filterCategoryIds.length === 0) {
        logger.info(`Subject area filter '${subjectArea}' has no categories. Returning empty keyword vectors.`);
        return defaultResponse;
      }

      params.push(filterCategoryIds);
      const filterCatIdx = params.length;
      cteParts.push(`sa_filter AS (
        SELECT a.article_id FROM "Article" a
        JOIN "Topic" t ON a.primary_topic = t.topic_id
        WHERE t.subject_category_id = ANY($${filterCatIdx}::bigint[]) AND COALESCE(a.is_deleted, false) = false
        UNION
        SELECT st.article_id FROM "Sub_Topic" st
        JOIN "Topic" t ON st.topic_id = t.topic_id
        WHERE t.subject_category_id = ANY($${filterCatIdx}::bigint[])
      )`);
    }

    // 3. Client filter: keywords
    if (keywordList.length > 0) {
      const kwRes = await client.query(
        `SELECT keyword_id FROM "Keyword" WHERE LOWER(display_name) = ANY($1::text[])`,
        [keywordList.map(s => s.toLowerCase())]
      );
      const filterKeywordIds = kwRes.rows.map(r => Number(r.keyword_id));

      if (filterKeywordIds.length === 0) {
        logger.info(`None of the keywords in filter matched. Returning empty keyword vectors.`);
        return defaultResponse;
      }

      params.push(filterKeywordIds);
      const filterKwIdx = params.length;
      cteParts.push(`kw_filter AS (
        SELECT article_id FROM "Keyword_Article" WHERE keyword_id = ANY($${filterKwIdx}::bigint[])
      )`);
    }

    // 4. Combine into filtered_articles
    const joinClauses = [];
    if (scope.subjectCategoryIds.length > 0 || scope.keywordIds.length > 0) {
      joinClauses.push('JOIN project_scope ps ON a.article_id = ps.article_id');
    }
    if (subjectArea) {
      joinClauses.push('JOIN sa_filter saf ON a.article_id = saf.article_id');
    }
    if (keywordList.length > 0) {
      joinClauses.push('JOIN kw_filter kwf ON a.article_id = kwf.article_id');
    }

    const yearFilters = [];
    if (fromYear !== undefined && fromYear !== null) {
      params.push(Number(fromYear));
      yearFilters.push(`a.publication_year >= $${params.length}`);
    }
    if (toYear !== undefined && toYear !== null) {
      params.push(Number(toYear));
      yearFilters.push(`a.publication_year <= $${params.length}`);
    }
    const yearWhere = yearFilters.length > 0 ? `AND ${yearFilters.join(' AND ')}` : '';

    cteParts.push(`filtered_articles AS (
      SELECT a.article_id, a.publication_year
      FROM "Article" a
      ${joinClauses.join(' ')}
      WHERE COALESCE(a.is_deleted, false) = false ${yearWhere}
    )`);

    const cteSql = `WITH ${cteParts.join(', ')}`;

    // 2. Query to find latest year
    const latestYearQuery = `
      ${cteSql}
      SELECT MAX(publication_year)::integer AS latest_year
      FROM filtered_articles
    `;

    const latestYearRes = await client.query(latestYearQuery, params);
    const latestYear = latestYearRes.rows[0]?.latest_year;

    if (!latestYear) {
      logger.info(`No publications found matching criteria. Returning empty vectors.`);
      return defaultResponse;
    }

    // 3. Compute years window for Current and Previous periods
    const yearsWindow = Math.ceil(windowMonths / 12);
    const currentYears = [];
    for (let i = 0; i < yearsWindow; i++) {
      currentYears.push(latestYear - i);
    }
    const previousYears = [];
    for (let i = 0; i < yearsWindow; i++) {
      previousYears.push(latestYear - yearsWindow - i);
    }

    // 4. Query volumes for each keyword during Current and Previous periods
    params.push(currentYears);
    const currentYearsParamIndex = params.length;
    params.push(previousYears);
    const previousYearsParamIndex = params.length;

    const query = `
      ${cteSql}
      SELECT
        k.display_name AS keyword,
        COUNT(DISTINCT CASE WHEN fa.publication_year = ANY($${currentYearsParamIndex}::integer[]) THEN fa.article_id END)::integer AS current_volume,
        COUNT(DISTINCT CASE WHEN fa.publication_year = ANY($${previousYearsParamIndex}::integer[]) THEN fa.article_id END)::integer AS previous_volume
      FROM "Keyword" k
      JOIN "Keyword_Article" ka ON k.keyword_id = ka.keyword_id
      JOIN filtered_articles fa ON ka.article_id = fa.article_id
      WHERE fa.publication_year = ANY($${currentYearsParamIndex}::integer[]) OR fa.publication_year = ANY($${previousYearsParamIndex}::integer[])
      GROUP BY k.keyword_id, k.display_name
    `;

    const result = await client.query(query, params);

    // 5. Calculate growth and filter zero-volume keywords
    const vectors = result.rows
      .map(row => {
        const currentVolume = Number(row.current_volume || 0);
        const previousVolume = Number(row.previous_volume || 0);

        let growth = 0;
        if (previousVolume === 0) {
          growth = currentVolume > 0 ? 100 : 0;
        } else {
          growth = ((currentVolume - previousVolume) / previousVolume) * 100;
        }

        return {
          keyword: String(row.keyword).trim(),
          volume: currentVolume,
          growth: Math.round(growth * 10) / 10 // Round to 1 decimal place
        };
      })
      .filter(item => {
        return (
          item.keyword !== null &&
          item.keyword !== undefined &&
          item.keyword !== '' &&
          item.volume > 0 && // Exclude zero volume keywords in the current period
          item.growth !== null &&
          item.growth !== undefined &&
          !Number.isNaN(item.growth) &&
          Number.isFinite(item.growth)
        );
      });

    // 6. Sort and Limit
    const finalizedData = vectors
      .sort((a, b) => {
        if (b.growth !== a.growth) {
          return b.growth - a.growth;
        }
        return b.volume - a.volume;
      })
      .slice(0, limit);

    // Save to Redis cache
    try {
      await redisSet(cacheKey, JSON.stringify(finalizedData), CACHE_TTL);
      logger.info(`[Redis] Keyword vectors cached for key: ${cacheKey}`);
    } catch (cacheErr) {
      logger.warn('Failed to save keyword vectors to Redis:', cacheErr?.message || cacheErr);
    }

    return finalizedData;

  } finally {
    client.release();
  }
}
