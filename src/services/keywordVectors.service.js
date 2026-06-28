import pool from '../config/database.js';
import logger from '../../utils/logger.js';
import { redisGet, redisSet } from './redis.service.js';
import { getProjectScope } from './forecast.service.js';

const CACHE_KEY_PREFIX = 'analytics:keywords:vectors';
const CACHE_TTL = 300; // 5 minutes

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
        logger.info(`None of the keywords in filter matched. Returning empty keyword vectors.`);
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

    // Client filter: year range (applied in SQL for filtering articles)
    if (fromYear !== undefined && fromYear !== null) {
      params.push(Number(fromYear));
      sqlFilters.push(`a.publication_year >= $${params.length}`);
    }
    if (toYear !== undefined && toYear !== null) {
      params.push(Number(toYear));
      sqlFilters.push(`a.publication_year <= $${params.length}`);
    }

    const whereClause = sqlFilters.length > 0 ? `AND ${sqlFilters.join(' AND ')}` : '';

    // 2. Query to find latest year
    const latestYearQuery = `
      SELECT MAX(a.publication_year)::integer AS latest_year
      FROM "Article" a
      WHERE COALESCE(a.is_deleted, false) = false
        ${whereClause}
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
    // Push currentYears and previousYears arrays into parameters
    params.push(currentYears);
    const currentYearsParamIndex = params.length;
    params.push(previousYears);
    const previousYearsParamIndex = params.length;

    const query = `
      SELECT
        k.display_name AS keyword,
        COUNT(DISTINCT CASE WHEN a.publication_year = ANY($${currentYearsParamIndex}::integer[]) THEN a.article_id END)::integer AS current_volume,
        COUNT(DISTINCT CASE WHEN a.publication_year = ANY($${previousYearsParamIndex}::integer[]) THEN a.article_id END)::integer AS previous_volume
      FROM "Keyword" k
      JOIN "Keyword_Article" ka ON k.keyword_id = ka.keyword_id
      JOIN "Article" a ON ka.article_id = a.article_id
      WHERE COALESCE(a.is_deleted, false) = false
        AND (a.publication_year = ANY($${currentYearsParamIndex}::integer[]) OR a.publication_year = ANY($${previousYearsParamIndex}::integer[]))
        ${whereClause}
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
