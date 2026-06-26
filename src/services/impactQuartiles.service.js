import pool from '../config/database.js';
import logger from '../../utils/logger.js';
import { redisGet, redisSet } from './redis.service.js';

// Cache configuration
const CACHE_KEY_PREFIX = 'analytics:impact-quartiles';
const CACHE_TTL = 300; // 5 minutes

/**
 * Main service to get geographical distribution analytics for a project with optional filters.
 * 
 * @param {string|number} projectId - ID of the project.
 * @param {object} filters - Additional query filters.
 * @param {string} [filters.subjectArea] - Optional subject area filter.
 * @param {string|string[]} [filters.keywords] - Optional keywords list.
 * @param {number} [filters.fromYear] - Optional start year.
 * @param {number} [filters.toYear] - Optional end year.
 * @returns {Promise<object>}
 */
export async function getImpactQuartiles(projectId, filters = {}) {
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
      logger.info(`[Redis] Impact-quartiles cache hit for key: ${cacheKey}`);
      return JSON.parse(cachedData);
    }
  } catch (err) {
    logger.warn('Failed to get impact-quartiles from Redis, fallback to DB:', err?.message || err);
  }

  const client = await pool.connect();

  const defaultResponse = {
    title: 'Impact Quartiles',
    description: 'Dominant publication quartile by citation ranking',
    quartile: null,
    percentage: 0,
    count: 0,
    totalPublications: 0
  };

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

    // If both project subject area categories and keywords are empty, return default response
    if (projectCategoryIds.length === 0 && projectKeywordIds.length === 0) {
      logger.info(`Project ${projectId} has no tracking scope. Returning empty quartile summary.`);
      return defaultResponse;
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
        logger.info(`Subject area filter '${subjectArea}' not found. Returning empty summary.`);
        return defaultResponse;
      }

      const saId = saRes.rows[0].subject_area_id;

      // Get categories under this subject_area
      const scRes = await client.query(
        `SELECT subject_category_id FROM "Subject_Category" WHERE subject_area_id = $1 AND COALESCE(is_deleted, false) = false`,
        [saId]
      );
      const filterCategoryIds = scRes.rows.map(r => Number(r.subject_category_id));

      if (filterCategoryIds.length === 0) {
        logger.info(`Subject area filter '${subjectArea}' has no categories. Returning empty summary.`);
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

    // Client custom filter: keywords
    if (keywordList.length > 0) {
      const kwRes = await client.query(
        `SELECT keyword_id FROM "Keyword" WHERE LOWER(display_name) = ANY($1::text[])`,
        [keywordList.map(s => s.toLowerCase())]
      );
      const filterKeywordIds = kwRes.rows.map(r => Number(r.keyword_id));

      if (filterKeywordIds.length === 0) {
        logger.info(`None of the keywords in filter matched. Returning empty summary.`);
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

    // Query publication count grouped by Best SJR Quartile (rm.code = 'SJR_BEST_QUARTILE')
    const querySql = `
      SELECT 
        jr.value_txt AS "quartile",
        COUNT(DISTINCT a.article_id)::integer AS count
      FROM "Article" a
      JOIN "Issue" i ON a.issue_id = i.issue_id AND COALESCE(i.is_deleted, false) = false
      JOIN "Volume" v ON i.volume_id = v.volume_id AND COALESCE(v.is_deleted, false) = false
      JOIN "Journal" j ON v.journal_id = j.journal_id AND COALESCE(j.is_deleted, false) = false
      JOIN "Journal_Ranking" jr ON jr.journal_id = j.journal_id AND jr.value_txt IN ('Q1', 'Q2', 'Q3', 'Q4')
      JOIN "Ranking_Metric" rm ON jr.metric_id = rm.metric_id AND rm.code = 'SJR_BEST_QUARTILE'
      WHERE COALESCE(a.is_deleted, false) = false
        ${whereClause}
      GROUP BY jr.value_txt
    `;

    const result = await client.query(querySql, params);

    // Parse counts
    const counts = { Q1: 0, Q2: 0, Q3: 0, Q4: 0 };
    let totalPublications = 0;

    for (const row of result.rows) {
      const q = String(row.quartile).toUpperCase().trim();
      if (counts[q] !== undefined) {
        counts[q] = Number(row.count || 0);
        totalPublications += counts[q];
      } else {
        logger.warn(`Skipping invalid quartile value: '${row.quartile}'`);
      }
    }

    // If no publications have quartile data, return defaultResponse
    if (totalPublications === 0) {
      logger.info(`No articles matching project scope have valid quartile ranking.`);
      return defaultResponse;
    }

    // Calculate percentage for each quartile
    const metrics = Object.keys(counts).map(q => {
      const count = counts[q];
      const percentage = Math.round((count / totalPublications) * 100);
      return {
        quartile: q,
        count,
        percentage
      };
    });

    // Select dominant quartile using tie-breaking: Q1 > Q2 > Q3 > Q4
    const priority = { Q1: 4, Q2: 3, Q3: 2, Q4: 1 };
    metrics.sort((a, b) => {
      if (b.percentage !== a.percentage) {
        return b.percentage - a.percentage; // Highest percentage first
      }
      return priority[b.quartile] - priority[a.quartile]; // Higher priority first
    });

    const dominant = metrics[0];

    const finalizedData = {
      title: 'Impact Quartiles',
      description: 'Dominant publication quartile by citation ranking',
      quartile: dominant.quartile,
      percentage: dominant.percentage,
      count: dominant.count,
      totalPublications
    };

    // Save to Redis cache
    try {
      await redisSet(cacheKey, JSON.stringify(finalizedData), CACHE_TTL);
      logger.info(`[Redis] Impact-quartiles summary cached for key: ${cacheKey}`);
    } catch (cacheErr) {
      logger.warn('Failed to save impact-quartiles to Redis:', cacheErr?.message || cacheErr);
    }

    return finalizedData;

  } finally {
    client.release();
  }
}
