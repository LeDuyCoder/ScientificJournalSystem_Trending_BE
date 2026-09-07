import pool from '../../../../config/database.js';
import logger from '../../../../utils/logger.js';
import { redisGet, redisSet } from '../../../core/services/infrastructure/redis.service.js';
import { getProjectScope } from '../trends/forecast.service.js';

const CACHE_KEY_PREFIX = 'analytics:matrix:productivity';
const CACHE_TTL = 43200; // 12 hours // 5 minutes

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
        logger.info(`None of the keywords in filter matched. Returning empty productivity matrix.`);
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
      SELECT a.article_id, a.publication_year, a.citation_count
      FROM "Article" a
      ${joins.join('\n      ')}
      WHERE COALESCE(a.is_deleted, false) = false
        ${yearSql}
    )`);

    const cteSql = `WITH ${cteParts.join(',\n')}`;

    let matrixPoints = [];

    const isYearRangeSupplied = fromYear !== undefined && fromYear !== null && toYear !== undefined && toYear !== null;

    if (isYearRangeSupplied) {
      // 1. If year range is supplied, calculate output = totalArticles / numberOfYears
      const query = `
        ${cteSql}
        SELECT
          au.author_id AS "authorId",
          au.display_name AS "authorName",
          COUNT(DISTINCT a.article_id)::integer AS total_articles,
          COALESCE(au.h_index, 0)::integer AS "hIndex"
        FROM "Author" au
        JOIN "Author_Article" aa ON au.author_id = aa.author_id
        JOIN filtered_articles a ON aa.article_id = a.article_id
        WHERE COALESCE(au.is_deleted, false) = false
          AND au.author_id IS NOT NULL
        GROUP BY au.author_id, au.display_name, au.h_index
      `;

      const result = await client.query(query, params);

      const numberOfYears = Number(toYear) - Number(fromYear) + 1;

      matrixPoints = result.rows.map(row => {
        const totalArticles = Number(row.total_articles || 0);
        const yearlyOutput = Math.round(totalArticles / numberOfYears);
        return {
          authorId: String(row.authorId),
          authorName: row.authorName || null,
          yearlyOutput,
          hIndex: Number(row.hIndex)
        };
      });

    } else {
      // 2. If no year range is supplied, calculate output = publications in the newest year of active publications
      const query = `
        ${cteSql},
        AuthorYearlyCount AS (
          SELECT
            au.author_id,
            a.publication_year,
            COUNT(DISTINCT a.article_id) AS article_count,
            ROW_NUMBER() OVER (PARTITION BY au.author_id ORDER BY a.publication_year DESC) as rn
          FROM "Author" au
          JOIN "Author_Article" aa ON au.author_id = aa.author_id
          JOIN filtered_articles a ON aa.article_id = a.article_id
          WHERE COALESCE(au.is_deleted, false) = false
            AND au.author_id IS NOT NULL
          GROUP BY au.author_id, a.publication_year
        )
        SELECT
          ay.author_id AS "authorId",
          au.display_name AS "authorName",
          ay.article_count AS "yearlyOutput",
          COALESCE(au.h_index, 0)::integer AS "hIndex"
        FROM AuthorYearlyCount ay
        JOIN "Author" au ON ay.author_id = au.author_id
        WHERE ay.rn = 1
      `;

      const result = await client.query(query, params);

      matrixPoints = result.rows.map(row => ({
        authorId: String(row.authorId),
        authorName: row.authorName || null,
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
