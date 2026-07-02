import pool from '../config/database.js';
import logger from '../../utils/logger.js';
import { redisGet, redisSet } from './redis.service.js';

const CACHE_KEY_PREFIX = 'analytics:impact-matrix:v1';
const CACHE_TTL = 3600; // 1 hour

function parseKeywordFilter(keywords) {
  if (!keywords) return [];
  return keywords.split(',').map(k => k.trim()).filter(Boolean);
}

export async function getImpactMatrixData(filters) {
  const { projectId, subjectArea, keywords, fromYear, toYear, limit = 50 } = filters;

  const keywordList = parseKeywordFilter(keywords);
  const normalizedKeywords = [...keywordList].map(s => s.toLowerCase()).sort().join(',');
  const cacheKey = `${CACHE_KEY_PREFIX}:${projectId}:${(subjectArea || '').toLowerCase()}:${normalizedKeywords}:${fromYear || ''}:${toYear || ''}:${limit}`;

  try {
    const cachedData = await redisGet(cacheKey);
    if (cachedData) {
      logger.info(`[Redis] Cache hit for impact matrix: ${cacheKey}`);
      return JSON.parse(cachedData);
    }
    logger.info(`[Redis] Cache miss for impact matrix: ${cacheKey}`);
  } catch (err) {
    logger.warn('Failed to get impact matrix from Redis, querying DB:', err?.message || err);
  }

  const client = await pool.connect();
  try {
    // 1. Get Project Scope
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

    // 2. Build Article Filters
    const params = [];
    const articleFilters = [];

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
          jr.value_float,
          jr.value_int,
          jr.value_txt,
          ROW_NUMBER() OVER(PARTITION BY jr.journal_id, rm.code ORDER BY jr.year DESC) as rn
        FROM "Journal_Ranking" jr
        JOIN "Ranking_Metric" rm ON rm.metric_id = jr.metric_id
        WHERE jr.journal_id IN (SELECT journal_id FROM journal_stats)
          AND rm.code IN ('SJR', 'H_INDEX', 'SJR_BEST_QUARTILE')
          ${yearFilter}
      ),
      journal_metrics AS (
        SELECT 
          journal_id,
          MAX(CASE WHEN code = 'SJR' THEN value_float END) AS sjr_score,
          MAX(CASE WHEN code = 'H_INDEX' THEN value_int END) AS h_index,
          MAX(CASE WHEN code = 'SJR_BEST_QUARTILE' THEN value_txt END) AS quartile
        FROM journal_metrics_raw
        WHERE rn = 1
        GROUP BY journal_id
      )
      SELECT 
        js.journal_name AS "journalName",
        COALESCE(jm.sjr_score, 0) AS "sjrCitationScore",
        COALESCE(jm.h_index, 0) AS "hIndex",
        COALESCE(jm.quartile, 'Q3') AS "quartile",
        js.article_count AS "size"
      FROM journal_stats js
      LEFT JOIN journal_metrics jm ON js.journal_id = jm.journal_id
      ORDER BY "sjrCitationScore" DESC, "size" DESC
      LIMIT $${params.length + 1}
    `;
    params.push(limit);

    const result = await client.query(sql, params);
    const finalResponse = result.rows.map(r => ({
      ...r,
      sjrCitationScore: Number(r.sjrCitationScore),
      hIndex: Number(r.hIndex),
      size: Number(r.size)
    }));

    try {
      await redisSet(cacheKey, JSON.stringify(finalResponse), CACHE_TTL);
      logger.info(`[Redis] Impact matrix cached: ${cacheKey}`);
    } catch (err) {
      logger.warn('Failed to set impact matrix cache:', err?.message || err);
    }

    return finalResponse;
  } catch (error) {
    logger.error('Error fetching impact matrix data:', error);
    if (error.status) throw error;
    throw new Error('Internal server error while fetching impact matrix');
  } finally {
    client.release();
  }
}
