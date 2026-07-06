import pool from '../config/database.js';
import logger from '../utils/logger.js';
import { redisGet, redisSet } from './redis.service.js';

// Cache configuration
const CACHE_KEY_PREFIX = 'analytics:geo-distribution';
const CACHE_TTL = 300; // 5 minutes

/**
 * Validate standard ISO Alpha-2 country code
 * @param {string} code 
 * @returns {boolean}
 */
function isValidCountryCode(code) {
  return typeof code === 'string' && /^[A-Z]{2}$/.test(code);
}

/**
 * Calculate the intensity of research publication density per country based on percentiles.
 * 
 * Rules:
 * - Top 10% -> PEAK (And index 0 is always PEAK to handle small list lengths)
 * - Top 30% -> HIGH
 * - Top 60% -> MEDIUM
 * - Rest -> LOW
 * 
 * @param {Array<object>} countryMetrics 
 * @returns {Array<object>}
 */
function calculateGeoIntensity(countryMetrics) {
  if (!countryMetrics || countryMetrics.length === 0) return [];

  // Sort descending by count just in case
  const sorted = [...countryMetrics].sort((a, b) => b.count - a.count);
  const L = sorted.length;

  return sorted.map((item, i) => {
    const percentile = i / L;
    let intensity = 'LOW';

    if (percentile < 0.1 || i === 0) {
      intensity = 'PEAK';
    } else if (percentile < 0.3) {
      intensity = 'HIGH';
    } else if (percentile < 0.6) {
      intensity = 'MEDIUM';
    }

    return {
      countryCode: item.countryCode,
      intensity,
      count: item.count
    };
  });
}

/**
 * Main service to get geographical distribution analytics for a project with optional filters.
 * 
 * @param {string|number} projectId - ID of the project.
 * @param {object} filters - Additional query filters.
 * @param {string} [filters.subjectArea] - Optional subject area filter.
 * @param {string|string[]} [filters.keywords] - Optional keywords list.
 * @param {number} [filters.fromYear] - Optional start year.
 * @param {number} [filters.toYear] - Optional end year.
 * @returns {Promise<Array<object>>}
 */
export async function getGeoDistribution(projectId, filters = {}) {
  const { subjectArea, keywords, fromYear, toYear } = filters;

  // Process keywords into a clean sorted string to form a stable cache key
  let normalizedKeywords = '';
  let keywordList = [];
  if (keywords) {
    keywordList = Array.isArray(keywords)
      ? keywords
      : String(keywords).split(',').map(s => s.trim()).filter(Boolean);
    normalizedKeywords = [...keywordList].map(s => s.toLowerCase()).sort().join(',');
  }

  // Build stable cache key
  const cacheKey = `${CACHE_KEY_PREFIX}:${projectId}:${(subjectArea || '').toLowerCase()}:${normalizedKeywords}:${fromYear || ''}:${toYear || ''}`;

  try {
    const cachedData = await redisGet(cacheKey);
    if (cachedData) {
      logger.info(`[Redis] Geo-distribution cache hit for key: ${cacheKey}`);
      return JSON.parse(cachedData);
    }
  } catch (err) {
    logger.warn('Failed to get geo-distribution from Redis, fallback to DB:', err?.message || err);
  }

  const client = await pool.connect();

  try {
    // 1. Verify project exists
    const projectRes = await client.query(
      `SELECT project_id, subject_area FROM "Project" WHERE project_id = $1`,
      [projectId]
    );

    if (projectRes.rows.length === 0) {
      const error = new Error('Project not found');
      error.code = 404;
      throw error;
    }

    const project = projectRes.rows[0];

    // 2. Fetch project's categories
    const categoriesRes = await client.query(
      `SELECT subject_category_id FROM "Subject_Category" WHERE subject_area_id = $1 AND COALESCE(is_deleted, false) = false`,
      [project.subject_area]
    );
    const projectCategoryIds = categoriesRes.rows.map(r => Number(r.subject_category_id));

    // 3. Fetch project's keywords
    const keywordsRes = await client.query(
      `SELECT keyword_id FROM "Project_Keyword" WHERE project_id = $1`,
      [projectId]
    );
    const projectKeywordIds = keywordsRes.rows.map(r => Number(r.keyword_id));

    // If both project subject area categories and keywords are empty, return empty result
    if (projectCategoryIds.length === 0 && projectKeywordIds.length === 0) {
      logger.info(`Project ${projectId} has no tracking scope. Returning empty array.`);
      return [];
    }

    const params = [];
    const sqlFilters = [];

    // Project scope filter block: (categories OR keywords)
    const scopeConditions = [];
    if (projectCategoryIds.length > 0) {
      params.push(projectCategoryIds);
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

    if (projectKeywordIds.length > 0) {
      params.push(projectKeywordIds);
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

    // Client custom filter: subject_area
    if (subjectArea) {
      // Find subject_area_id by display_name
      const saRes = await client.query(
        `SELECT subject_area_id FROM "Subject_Area" WHERE LOWER(display_name) = LOWER($1) AND COALESCE(is_deleted, false) = false`,
        [subjectArea.trim()]
      );

      if (saRes.rows.length === 0) {
        logger.info(`Subject area filter '${subjectArea}' not found. Returning empty array.`);
        return [];
      }

      const saId = saRes.rows[0].subject_area_id;

      // Get categories under this subject_area
      const scRes = await client.query(
        `SELECT subject_category_id FROM "Subject_Category" WHERE subject_area_id = $1 AND COALESCE(is_deleted, false) = false`,
        [saId]
      );
      const filterCategoryIds = scRes.rows.map(r => Number(r.subject_category_id));

      if (filterCategoryIds.length === 0) {
        logger.info(`Subject area filter '${subjectArea}' has no categories. Returning empty array.`);
        return [];
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

    // Client custom filter: keywords
    if (keywordList.length > 0) {
      const kwRes = await client.query(
        `SELECT keyword_id FROM "Keyword" WHERE LOWER(display_name) = ANY($1::text[])`,
        [keywordList.map(s => s.toLowerCase())]
      );
      const filterKeywordIds = kwRes.rows.map(r => Number(r.keyword_id));

      if (filterKeywordIds.length === 0) {
        logger.info(`None of the keywords in filter matched. Returning empty array.`);
        return [];
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

    // Client custom filter: year range
    if (fromYear !== undefined && fromYear !== null) {
      params.push(Number(fromYear));
      sqlFilters.push(`a.publication_year >= $${params.length}`);
    }
    if (toYear !== undefined && toYear !== null) {
      params.push(Number(toYear));
      sqlFilters.push(`a.publication_year <= $${params.length}`);
    }

    const whereClause = sqlFilters.length > 0 ? `AND ${sqlFilters.join(' AND ')}` : '';

    const querySql = `
      SELECT 
        z.code AS "countryCode",
        COUNT(DISTINCT a.article_id)::integer AS count
      FROM "Article" a
      JOIN "Issue" i ON a.issue_id = i.issue_id AND COALESCE(i.is_deleted, false) = false
      JOIN "Volume" v ON i.volume_id = v.volume_id AND COALESCE(v.is_deleted, false) = false
      JOIN "Journal" j ON v.journal_id = j.journal_id AND COALESCE(j.is_deleted, false) = false
      JOIN "Zone" z ON j.country = z.zone_id AND z.type = 'COUNTRY'
      WHERE COALESCE(a.is_deleted, false) = false
        ${whereClause}
      GROUP BY z.code
      ORDER BY count DESC
    `;

    const result = await client.query(querySql, params);

    // Filter and clean country records
    const validRecords = [];
    for (const row of result.rows) {
      const code = row.countryCode ? String(row.countryCode).toUpperCase().trim() : null;
      if (!code || !isValidCountryCode(code)) {
        logger.warn(`Skipping invalid countryCode: '${row.countryCode}'`);
        continue;
      }
      validRecords.push({
        countryCode: code,
        count: Number(row.count || 0)
      });
    }

    // Calculate dynamic intensity
    const finalizedData = calculateGeoIntensity(validRecords);

    // Save to Redis cache
    try {
      await redisSet(cacheKey, JSON.stringify(finalizedData), CACHE_TTL);
      logger.info(`[Redis] Geo-distribution results cached for key: ${cacheKey}`);
    } catch (cacheErr) {
      logger.warn('Failed to save geo-distribution to Redis:', cacheErr?.message || cacheErr);
    }

    return finalizedData;

  } finally {
    client.release();
  }
}
