import pool from '../config/database.js';
import logger from '../../utils/logger.js';
import { redisGet, redisSet } from './redis.service.js';

const CACHE_KEY_PREFIX = 'analytics:journal-ranking:v1';
const CACHE_TTL = 3600; // 1 hour

/**
 * Parses a comma-separated string of keywords into a clean array.
 * @param {string|undefined} keywords
 * @returns {string[]}
 */
function parseKeywordFilter(keywords) {
  if (!keywords) return [];
  return keywords.split(',').map(k => k.trim()).filter(Boolean);
}

/**
 * Main service function to get journal rankings.
 * @param {object} filters
 * @param {string} filters.projectId
 * @param {string} [filters.subjectArea]
 * @param {string} [filters.keywords]
 * @param {number} [filters.fromYear]
 * @param {number} [filters.toYear]
 * @param {number} [filters.limit]
 * @returns {Promise<Array<object>>}
 */
export async function getJournalRanking(filters) {
  const { projectId, subjectArea, keywords, fromYear, toYear, limit = 50 } = filters;

  const keywordList = parseKeywordFilter(keywords);
  const normalizedKeywords = [...keywordList].map(s => s.toLowerCase()).sort().join(',');

  const cacheKey = `${CACHE_KEY_PREFIX}:${projectId}:${(subjectArea || '').toLowerCase()}:${normalizedKeywords}:${fromYear || ''}:${toYear || ''}:${limit}`;

  try {
    const cachedData = await redisGet(cacheKey);
    if (cachedData) {
      logger.info(`[Redis] Cache hit for journal ranking: ${cacheKey}`);
      return JSON.parse(cachedData);
    }
    logger.info(`[Redis] Cache miss for journal ranking: ${cacheKey}`);
  } catch (err) {
    logger.warn('Failed to get journal ranking from Redis, querying database:', err?.message || err);
  }

  const client = await pool.connect();
  try {
    // Step 1: Get Project Scope
    const projectRes = await client.query(`SELECT subject_area FROM "Project" WHERE project_id = $1`, [projectId]);
    if (projectRes.rows.length === 0) {
      const error = new Error('Project not found');
      error.status = 404;
      throw error;
    }
    const projectSubjectAreaId = projectRes.rows[0].subject_area;

    const categoriesRes = await client.query(`SELECT subject_category_id FROM "Subject_Category" WHERE subject_area_id = $1 AND COALESCE(is_deleted, false) = false`, [projectSubjectAreaId]);
    const scopeCategoryIds = categoriesRes.rows.map(r => Number(r.subject_category_id));

    const keywordsRes = await client.query(`SELECT keyword_id FROM "Project_Keyword" WHERE project_id = $1`, [projectId]);
    const scopeKeywordIds = keywordsRes.rows.map(r => Number(r.keyword_id));

    if (scopeCategoryIds.length === 0 && scopeKeywordIds.length === 0) {
      return [];
    }

    // Step 2: Build query to get filtered articles
    const params = [];
    const articleFilters = [];

    // Project Scope filter
    const scopeConditions = [];
    if (scopeCategoryIds.length > 0) {
      params.push(scopeCategoryIds);
      scopeConditions.push(`(
        EXISTS (SELECT 1 FROM "Topic" t WHERE t.topic_id = a.primary_topic AND t.subject_category_id = ANY($${params.length}::bigint[]))
        OR EXISTS (SELECT 1 FROM "Sub_Topic" st JOIN "Topic" t ON st.topic_id = t.topic_id WHERE st.article_id = a.article_id AND t.subject_category_id = ANY($${params.length}::bigint[]))
      )`);
    }
    if (scopeKeywordIds.length > 0) {
      params.push(scopeKeywordIds);
      scopeConditions.push(`EXISTS (SELECT 1 FROM "Keyword_Article" ka WHERE ka.article_id = a.article_id AND ka.keyword_id = ANY($${params.length}::bigint[]))`);
    }
    articleFilters.push(`(${scopeConditions.join(' OR ')})`);

    // Additional client filters
    if (subjectArea) {
      params.push(subjectArea.trim().toLowerCase());
      articleFilters.push(`EXISTS (
        SELECT 1 FROM "Topic" t
        JOIN "Subject_Category" sc ON t.subject_category_id = sc.subject_category_id
        JOIN "Subject_Area" sa ON sc.subject_area_id = sa.subject_area_id
        WHERE (t.topic_id = a.primary_topic OR EXISTS(SELECT 1 FROM "Sub_Topic" st WHERE st.article_id = a.article_id AND st.topic_id = t.topic_id))
        AND LOWER(sa.display_name) = $${params.length}
      )`);
    }
    if (keywordList.length > 0) {
      params.push(keywordList.map(k => k.toLowerCase()));
      articleFilters.push(`EXISTS (
        SELECT 1 FROM "Keyword_Article" ka JOIN "Keyword" k ON ka.keyword_id = k.keyword_id
        WHERE ka.article_id = a.article_id AND LOWER(k.display_name) = ANY($${params.length}::text[])
      )`);
    }
    if (fromYear) {
      params.push(fromYear);
      articleFilters.push(`a.publication_year >= $${params.length}`);
    }
    if (toYear) {
      params.push(toYear);
      articleFilters.push(`a.publication_year <= $${params.length}`);
    }

    const yearFilter = toYear ? `AND jr.year <= ${Number(toYear)}` : '';

    const sql = `
      WITH project_articles AS (
        SELECT a.article_id, j.journal_id, j.display_name AS journal_name
        FROM "Article" a
        JOIN "Issue" i ON a.issue_id = i.issue_id
        JOIN "Volume" v ON i.volume_id = v.volume_id
        JOIN "Journal" j ON v.journal_id = j.journal_id
        WHERE COALESCE(a.is_deleted, false) = false
          AND COALESCE(j.is_deleted, false) = false
          AND ${articleFilters.join(' AND ')}
      ),
      journal_stats AS (
        SELECT 
          journal_id, 
          MAX(journal_name) AS journal_name, 
          COUNT(DISTINCT article_id) AS article_count
        FROM project_articles
        GROUP BY journal_id
      ),
      journal_metrics_raw AS (
        SELECT 
          jr.journal_id,
          rm.code,
          jr.value_txt,
          ROW_NUMBER() OVER(PARTITION BY jr.journal_id, rm.code ORDER BY jr.year DESC) as rn
        FROM "Journal_Ranking" jr
        JOIN "Ranking_Metric" rm ON rm.metric_id = jr.metric_id
        WHERE jr.journal_id IN (SELECT journal_id FROM journal_stats)
          AND rm.code IN ('IMPACT_FACTOR', 'IF', 'IF_SCORE', 'SJR')
          ${yearFilter}
      ),
      journal_metrics AS (
        SELECT 
          journal_id,
          COALESCE(
            MAX(CASE WHEN code IN ('IMPACT_FACTOR', 'IF', 'IF_SCORE') THEN NULLIF(value_txt, '')::numeric END),
            MAX(CASE WHEN code = 'SJR' THEN NULLIF(value_txt, '')::numeric END)
          ) AS impact_factor
        FROM journal_metrics_raw
        WHERE rn = 1
        GROUP BY journal_id
      )
      SELECT 
        js.journal_name AS name,
        COALESCE(jm.impact_factor, 0) AS "impactFactor"
      FROM journal_stats js
      LEFT JOIN journal_metrics jm ON js.journal_id = jm.journal_id
      ORDER BY "impactFactor" DESC, js.article_count DESC, js.journal_name ASC
      LIMIT $${params.length + 1}
    `;
    params.push(limit);

    const result = await client.query(sql, params);
    
    const finalResponse = result.rows.map(row => {
      const val = row.impactFactor;
      return {
        ...row,
        impactFactor: val != null ? Number(val) : null
      };
    });

    try {
      await redisSet(cacheKey, JSON.stringify(finalResponse), CACHE_TTL);
      logger.info(`[Redis] Journal ranking cached: ${cacheKey}`);
    } catch (err) {
      logger.warn('Failed to set journal ranking in Redis cache:', err?.message || err);
    }

    return finalResponse;

  } catch (error) {
    logger.error('Error fetching journal ranking:', error);
    if (error.status) {
      throw error;
    }
    throw new Error('An internal error occurred while fetching journal ranking.');
  } finally {
    client.release();
  }
}
