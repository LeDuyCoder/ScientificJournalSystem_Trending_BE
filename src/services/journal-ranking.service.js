import pool from '../config/database.js';
import logger from '../utils/logger.js';
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
  const { projectId, subjectArea, keywords, fromYear, toYear, page = 1, limit = 10 } = filters;

  const pageNum = Math.max(1, Number(page));
  const limitNum = Math.max(1, Number(limit));
  const offset = (pageNum - 1) * limitNum;

  const keywordList = parseKeywordFilter(keywords);
  const normalizedKeywords = [...keywordList].map(s => s.toLowerCase()).sort().join(',');

  const cacheKey = `${CACHE_KEY_PREFIX}:${projectId}:${(subjectArea || '').toLowerCase()}:${normalizedKeywords}:${fromYear || ''}:${toYear || ''}:${pageNum}:${limitNum}`;

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
      return {
        journals: [],
        pagination: { totalCount: 0, page: pageNum, limit: limitNum, totalPages: 0 },
        summary: { averageImpactFactor: 0, percentageChange: '+0.0%', trackedCount: 0, limit: 100 }
      };
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
        SELECT 
          a.article_id, 
          j.journal_id, 
          j.display_name AS journal_name,
          j.issn,
          p.display_name AS publisher_name
        FROM "Article" a
        JOIN "Issue" i ON a.issue_id = i.issue_id
        JOIN "Volume" v ON i.volume_id = v.volume_id
        JOIN "Journal" j ON v.journal_id = j.journal_id
        LEFT JOIN "Publisher" p ON j.publisher_id = p.publisher_id
        WHERE COALESCE(a.is_deleted, false) = false
          AND COALESCE(j.is_deleted, false) = false
          AND ${articleFilters.join(' AND ')}
      ),
      journal_stats AS (
        SELECT 
          journal_id, 
          MAX(journal_name) AS journal_name, 
          MAX(issn) AS issn,
          MAX(publisher_name) AS publisher_name,
          COUNT(DISTINCT article_id) AS article_count
        FROM project_articles
        GROUP BY journal_id
      ),
      journal_metrics_raw AS (
        SELECT 
          jr.journal_id,
          jr.value_float,
          ROW_NUMBER() OVER(PARTITION BY jr.journal_id ORDER BY jr.year DESC) as rn
        FROM "Journal_Ranking" jr
        JOIN "Ranking_Metric" rm ON rm.metric_id = jr.metric_id
        WHERE jr.journal_id IN (SELECT journal_id FROM journal_stats)
          AND rm.code = 'SJR'
          ${yearFilter}
      ),
      journal_metrics AS (
        SELECT 
          journal_id,
          MAX(value_float) AS impact_factor
        FROM journal_metrics_raw
        WHERE rn = 1
        GROUP BY journal_id
      ),
      journal_quartiles_raw AS (
        SELECT 
          jr.journal_id,
          jr.value_txt AS sjr_rank,
          ROW_NUMBER() OVER(PARTITION BY jr.journal_id ORDER BY jr.year DESC) as rn
        FROM "Journal_Ranking" jr
        JOIN "Ranking_Metric" rm ON rm.metric_id = jr.metric_id
        WHERE jr.journal_id IN (SELECT journal_id FROM journal_stats)
          AND rm.metric_type = 'QUARTILE'
          AND jr.value_txt IN ('Q1', 'Q2', 'Q3', 'Q4')
          ${yearFilter}
      ),
      journal_quartiles AS (
        SELECT 
          journal_id,
          MAX(sjr_rank) AS sjr_rank
        FROM journal_quartiles_raw
        WHERE rn = 1
        GROUP BY journal_id
      ),
      journal_trend_raw AS (
        SELECT 
          jr.journal_id,
          jr.value_float,
          jr.year
        FROM "Journal_Ranking" jr
        JOIN "Ranking_Metric" rm ON rm.metric_id = jr.metric_id
        WHERE jr.journal_id IN (SELECT journal_id FROM journal_stats)
          AND rm.code = 'SJR'
          ${toYear ? `AND jr.year <= ${Number(toYear)}` : ''}
          AND jr.year >= 2020
      ),
      journal_trends AS (
        SELECT 
          journal_id,
          STRING_AGG(value_float::text, ',' ORDER BY year ASC) AS trend_str
        FROM journal_trend_raw
        GROUP BY journal_id
      )
      SELECT 
        js.journal_id AS id,
        js.journal_name AS name,
        COALESCE(js.publisher_name, 'Unknown') AS publisher,
        COALESCE(js.issn, 'N/A') AS issn,
        COALESCE(jm.impact_factor, 0) AS "impactFactor",
        COALESCE(jq.sjr_rank, 'Q4') AS "sjrRank",
        jt.trend_str AS "trendStr",
        COUNT(*) OVER() AS total_count
      FROM journal_stats js
      LEFT JOIN journal_metrics jm ON js.journal_id = jm.journal_id
      LEFT JOIN journal_quartiles jq ON js.journal_id = jq.journal_id
      LEFT JOIN journal_trends jt ON js.journal_id = jt.journal_id
      ORDER BY "impactFactor" DESC, js.article_count DESC, js.journal_name ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const queryParams = [...params, limitNum, offset];
    const result = await client.query(sql, queryParams);

    const summarySql = `
      WITH project_articles AS (
        SELECT DISTINCT j.journal_id
        FROM "Article" a
        JOIN "Issue" i ON a.issue_id = i.issue_id
        JOIN "Volume" v ON i.volume_id = v.volume_id
        JOIN "Journal" j ON v.journal_id = j.journal_id
        WHERE COALESCE(a.is_deleted, false) = false
          AND COALESCE(j.is_deleted, false) = false
          AND ${articleFilters.join(' AND ')}
      ),
      journal_metrics_current AS (
        SELECT 
          jr.journal_id,
          jr.value_float AS sjr,
          ROW_NUMBER() OVER(PARTITION BY jr.journal_id ORDER BY jr.year DESC) as rn
        FROM "Journal_Ranking" jr
        JOIN "Ranking_Metric" rm ON rm.metric_id = jr.metric_id
        WHERE jr.journal_id IN (SELECT journal_id FROM project_articles)
          AND rm.code = 'SJR'
          ${toYear ? `AND jr.year <= ${Number(toYear)}` : ''}
      ),
      journal_metrics_prev AS (
        SELECT 
          jr.journal_id,
          jr.value_float AS sjr,
          ROW_NUMBER() OVER(PARTITION BY jr.journal_id ORDER BY jr.year DESC) as rn
        FROM "Journal_Ranking" jr
        JOIN "Ranking_Metric" rm ON rm.metric_id = jr.metric_id
        WHERE jr.journal_id IN (SELECT journal_id FROM project_articles)
          AND rm.code = 'SJR'
          ${toYear ? `AND jr.year <= ${Number(toYear) - 1}` : `AND jr.year <= ${new Date().getFullYear() - 1}`}
      )
      SELECT 
        (SELECT AVG(sjr) FROM journal_metrics_current WHERE rn = 1) AS avg_sjr_current,
        (SELECT AVG(sjr) FROM journal_metrics_prev WHERE rn = 1) AS avg_sjr_prev,
        (SELECT COUNT(*) FROM project_articles) AS total_journals
    `;

    const summaryRes = await client.query(summarySql, params);

    const totalCount = result.rows.length > 0 ? Number(result.rows[0].total_count) : 0;

    const journals = result.rows.map(row => {
      let trend = [];
      if (row.trendStr) {
        trend = row.trendStr.split(',').map(Number);
      }
      return {
        id: row.id,
        name: row.name,
        publisher: row.publisher,
        issn: row.issn,
        impactFactor: Number(row.impactFactor),
        sjrRank: row.sjrRank,
        trend: trend
      };
    });

    const avgCurrent = Number(summaryRes.rows[0]?.avg_sjr_current || 0);
    const avgPrev = Number(summaryRes.rows[0]?.avg_sjr_prev || 0);
    const totalJournals = Number(summaryRes.rows[0]?.total_journals || 0);

    let percentageChange = '+0.0%';
    if (avgPrev > 0) {
      const change = ((avgCurrent - avgPrev) / avgPrev) * 100;
      percentageChange = change >= 0 ? `+${change.toFixed(1)}%` : `${change.toFixed(1)}%`;
    } else if (avgCurrent > 0) {
      percentageChange = '+100.0%';
    }

    const finalResponse = {
      journals,
      pagination: {
        totalCount,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(totalCount / limitNum)
      },
      summary: {
        averageImpactFactor: Math.round(avgCurrent * 100) / 100,
        percentageChange,
        trackedCount: totalJournals,
        limit: 150
      }
    };

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
