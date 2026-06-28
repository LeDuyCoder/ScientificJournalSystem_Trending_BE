import pool from '../config/database.js';
import logger from '../../utils/logger.js';
import { redisGet, redisSet } from './redis.service.js';
import { getProjectScope } from './forecast.service.js';

const CACHE_KEY_PREFIX = 'analytics:matrix:productivity';
const CACHE_TTL = 300; // 5 minutes

/**
 * Fetch coordinates for the Author Productivity vs Impact Matrix.
 *
 * @param {string|number} projectId
 * @param {object} filters
 * @param {string} [filters.subjectArea]
 * @param {string|string[]} [filters.keywords]
 * @param {number} [filters.fromYear]
 * @param {number} [filters.toYear]
 * @param {number} [filters.limit]
 * @returns {Promise<Array<object>>}
 */
export async function getProductivityMatrix(projectId, filters = {}) {
  const { subjectArea, keywords, fromYear, toYear } = filters;
  const limit = filters.limit ? Number(filters.limit) : 50;

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
      logger.info(`[Redis] Productivity matrix cache hit for key: ${cacheKey}`);
      return JSON.parse(cached);
    }
  } catch (err) {
    logger.warn('Failed to retrieve productivity matrix from Redis, fallback to DB:', err?.message || err);
  }

  const client = await pool.connect();
  const defaultResponse = [];

  try {
    // 1. Get project scope
    const scope = await getProjectScope(client, projectId);

    if (scope.subjectCategoryIds.length === 0 && scope.keywordIds.length === 0) {
      logger.info(`Project ${projectId} has no tracking scope. Returning empty productivity matrix.`);
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
        logger.info(`Subject area filter '${subjectArea}' not found. Returning empty productivity matrix.`);
        return defaultResponse;
      }

      const saId = saRes.rows[0].subject_area_id;

      const scRes = await client.query(
        `SELECT subject_category_id FROM "Subject_Category" WHERE subject_area_id = $1 AND COALESCE(is_deleted, false) = false`,
        [saId]
      );
      const filterCategoryIds = scRes.rows.map(r => Number(r.subject_category_id));

      if (filterCategoryIds.length === 0) {
        logger.info(`Subject area filter '${subjectArea}' has no categories. Returning empty productivity matrix.`);
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
        logger.info(`None of the keywords in filter matched. Returning empty productivity matrix.`);
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

    let matrixPoints = [];

    const isYearRangeSupplied = fromYear !== undefined && fromYear !== null && toYear !== undefined && toYear !== null;

    if (isYearRangeSupplied) {
      // 1. If year range is supplied, calculate output = totalArticles / numberOfYears
      const query = `
        SELECT
          au.author_id AS "authorId",
          COUNT(DISTINCT a.article_id)::integer AS total_articles,
          COALESCE(au.h_index, 0)::integer AS "hIndex"
        FROM "Author" au
        JOIN "Author_Article" aa ON au.author_id = aa.author_id
        JOIN "Article" a ON aa.article_id = a.article_id
        WHERE COALESCE(a.is_deleted, false) = false
          AND COALESCE(au.is_deleted, false) = false
          AND au.author_id IS NOT NULL
          ${whereClause}
        GROUP BY au.author_id, au.h_index
      `;

      const result = await client.query(query, params);

      const numberOfYears = Number(toYear) - Number(fromYear) + 1;

      matrixPoints = result.rows.map(row => {
        const totalArticles = Number(row.total_articles || 0);
        const yearlyOutput = Math.round(totalArticles / numberOfYears);
        return {
          authorId: String(row.authorId),
          yearlyOutput,
          hIndex: Number(row.hIndex)
        };
      });

    } else {
      // 2. If no year range is supplied, calculate output = publications in the newest year of active publications
      const query = `
        WITH AuthorYearlyCount AS (
          SELECT
            au.author_id,
            a.publication_year,
            COUNT(DISTINCT a.article_id) AS article_count,
            ROW_NUMBER() OVER (PARTITION BY au.author_id ORDER BY a.publication_year DESC) as rn
          FROM "Author" au
          JOIN "Author_Article" aa ON au.author_id = aa.author_id
          JOIN "Article" a ON aa.article_id = a.article_id
          WHERE COALESCE(a.is_deleted, false) = false
            AND COALESCE(au.is_deleted, false) = false
            AND au.author_id IS NOT NULL
            ${whereClause}
          GROUP BY au.author_id, a.publication_year
        )
        SELECT
          ay.author_id AS "authorId",
          ay.article_count AS "yearlyOutput",
          COALESCE(au.h_index, 0)::integer AS "hIndex"
        FROM AuthorYearlyCount ay
        JOIN "Author" au ON ay.author_id = au.author_id
        WHERE ay.rn = 1
      `;

      const result = await client.query(query, params);

      matrixPoints = result.rows.map(row => ({
        authorId: String(row.authorId),
        yearlyOutput: Number(row.yearlyOutput || 0),
        hIndex: Number(row.hIndex || 0)
      }));
    }

    // 3. Post-process: filter, sort and limit
    const finalizedData = matrixPoints
      .filter(item => {
        return (
          item.authorId !== null &&
          item.authorId !== undefined &&
          item.yearlyOutput !== null &&
          item.yearlyOutput !== undefined &&
          !Number.isNaN(item.yearlyOutput) &&
          item.yearlyOutput > 0 && // Only return authors that have publications in the filtered dataset
          item.hIndex !== null &&
          item.hIndex !== undefined &&
          !Number.isNaN(item.hIndex) &&
          item.hIndex >= 0
        );
      })
      .sort((a, b) => {
        if (b.hIndex !== a.hIndex) {
          return b.hIndex - a.hIndex;
        }
        return b.yearlyOutput - a.yearlyOutput;
      })
      .slice(0, limit);

    // Save to Redis cache
    try {
      await redisSet(cacheKey, JSON.stringify(finalizedData), CACHE_TTL);
      logger.info(`[Redis] Productivity matrix cached for key: ${cacheKey}`);
    } catch (cacheErr) {
      logger.warn('Failed to save productivity matrix to Redis:', cacheErr?.message || cacheErr);
    }

    return finalizedData;

  } finally {
    client.release();
  }
}
