import pool from '../../../../config/database.js';
import logger from '../../../../utils/logger.js';
import { fetchWithCache } from '../../../analytics/services/analytics/cache.service.js';
import { getResolvedScope } from '../../../analytics/services/analytics/scope.repository.js';
import { redisGet, redisSet } from '../../../core/services/infrastructure/redis.service.js';

const CACHE_KEY_PREFIX = 'analytics:journal-ranking:v2';
const CACHE_TTL = 43200; // 12 hours // 1 hour

export async function getJournalRanking(filters) {
  const { project_id: projectId, subject_area: subjectArea, keywords, from_year: fromYear, to_year: toYear, page = 1, limit = 10 } = filters;

  const pageNum = Math.max(1, Number(page));
  const limitNum = Math.max(1, Number(limit));
  const offset = (pageNum - 1) * limitNum;

  const queryParams = {
    project_id: projectId,
    domain: subjectArea,
    subject_category: keywords // the API maps keywords or category
  };

  const scope = await getResolvedScope(queryParams);

  const cacheKey = `${CACHE_KEY_PREFIX}:${scope.resolvedProjectId || 'all'}:${scope.mappedDomain}:${scope.projectCategoryIds.join(',')}:${fromYear || ''}:${toYear || ''}:${pageNum}:${limitNum}`;



  try {
    const cached = await redisGet(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (e) {
    console.warn('Redis error:', e);
  }

  const result = await (async () => {
    try {
      let params = [];
      let articleFilter = '';
      
      const yearConditions = [];
      if (fromYear) {
        yearConditions.push(`a.publication_year >= $${params.length + 1}`);
        params.push(Number(fromYear));
      }
      if (toYear) {
        yearConditions.push(`a.publication_year <= $${params.length + 1}`);
        params.push(Number(toYear));
      }
      const yearSql = yearConditions.length > 0 ? `AND ${yearConditions.join(' AND ')}` : '';
      const yearFilter = toYear ? `AND jr.year <= ${Number(toYear)}` : '';
      const yearPrevFilter = toYear ? `AND jr.year <= ${Number(toYear) - 1}` : `AND jr.year <= ${new Date().getFullYear() - 1}`;

      if (scope.hasProject && scope.projectCategoryIds.length > 0) {
        articleFilter = `
          WITH target_topics AS (
            SELECT topic_id FROM "Topic" WHERE subject_category_id = ANY($${params.length + 1}::bigint[])
          ),
          project_articles_issues AS (
            SELECT issue_id, article_id
            FROM "Article" a
            WHERE primary_topic IN (SELECT topic_id FROM target_topics)
              AND coalesce(is_deleted, false) = false
              ${yearSql}
            UNION
            SELECT a.issue_id, a.article_id
            FROM "Sub_Topic" st
            JOIN "Article" a ON st.article_id = a.article_id
            WHERE st.topic_id IN (SELECT topic_id FROM target_topics)
              AND coalesce(a.is_deleted, false) = false
              ${yearSql}
          ),
          issue_counts AS (
            SELECT issue_id, COUNT(DISTINCT article_id) AS cnt
            FROM project_articles_issues
            GROUP BY issue_id
          ),
          journal_stats AS (
            SELECT 
              v.journal_id, 
              SUM(ic.cnt) AS article_count
            FROM issue_counts ic
            JOIN "Issue" i ON ic.issue_id = i.issue_id
            JOIN "Volume" v ON i.volume_id = v.volume_id
            GROUP BY v.journal_id
          )
        `;
        params.push(scope.projectCategoryIds);
      } else if (scope.mappedDomain && scope.mappedDomain !== 'all') {
        articleFilter = `
          WITH target_topics AS (
            SELECT t.topic_id FROM "Topic" t
            JOIN "Subject_Category" sc ON t.subject_category_id = sc.subject_category_id
            JOIN "Subject_Area" sa ON sc.subject_area_id = sa.subject_area_id
            WHERE LOWER(sa.display_name) = LOWER($${params.length + 1})
          ),
          project_articles_issues AS (
            SELECT issue_id, article_id
            FROM "Article" a
            WHERE primary_topic IN (SELECT topic_id FROM target_topics)
              AND coalesce(is_deleted, false) = false
              ${yearSql}
            UNION
            SELECT a.issue_id, a.article_id
            FROM "Sub_Topic" st
            JOIN "Article" a ON st.article_id = a.article_id
            WHERE st.topic_id IN (SELECT topic_id FROM target_topics)
              AND coalesce(a.is_deleted, false) = false
              ${yearSql}
          ),
          issue_counts AS (
            SELECT issue_id, COUNT(DISTINCT article_id) AS cnt
            FROM project_articles_issues
            GROUP BY issue_id
          ),
          journal_stats AS (
            SELECT 
              v.journal_id, 
              SUM(ic.cnt) AS article_count
            FROM issue_counts ic
            JOIN "Issue" i ON ic.issue_id = i.issue_id
            JOIN "Volume" v ON i.volume_id = v.volume_id
            GROUP BY v.journal_id
          )
        `;
        params.push(scope.mappedDomain);
      } else {
        articleFilter = `
          WITH issue_counts AS (
            SELECT issue_id, COUNT(article_id) AS cnt
            FROM "Article" a
            WHERE coalesce(a.is_deleted, false) = false
            ${yearSql}
            GROUP BY issue_id
          ),
          journal_stats AS (
            SELECT v.journal_id, SUM(ic.cnt) AS article_count
            FROM issue_counts ic
            JOIN "Issue" i ON ic.issue_id = i.issue_id
            JOIN "Volume" v ON i.volume_id = v.volume_id
            GROUP BY v.journal_id
          )
        `;
      }

      const limitParamIdx = params.length + 1;
      params.push(limitNum);
      const offsetParamIdx = params.length + 1;
      params.push(offset);

      const sql = `
        ${articleFilter},
        journal_metrics_raw AS (
          SELECT jr.journal_id, jr.value_float, ROW_NUMBER() OVER(PARTITION BY jr.journal_id ORDER BY jr.year DESC) as rn
          FROM "Journal_Ranking" jr
          JOIN "Ranking_Metric" rm ON rm.metric_id = jr.metric_id
          WHERE jr.journal_id IN (SELECT journal_id FROM journal_stats)
            AND rm.code = 'SJR'
            ${yearFilter}
        ),
        journal_metrics AS (
          SELECT journal_id, MAX(value_float) AS impact_factor FROM journal_metrics_raw WHERE rn = 1 GROUP BY journal_id
        ),
        journal_quartiles_raw AS (
          SELECT jr.journal_id, jr.value_txt AS sjr_rank, ROW_NUMBER() OVER(PARTITION BY jr.journal_id ORDER BY jr.year DESC) as rn
          FROM "Journal_Ranking" jr
          JOIN "Ranking_Metric" rm ON rm.metric_id = jr.metric_id
          WHERE jr.journal_id IN (SELECT journal_id FROM journal_stats)
            AND rm.metric_type = 'QUARTILE'
            AND jr.value_txt IN ('Q1', 'Q2', 'Q3', 'Q4')
            ${yearFilter}
        ),
        journal_quartiles AS (
          SELECT journal_id, MAX(sjr_rank) AS sjr_rank FROM journal_quartiles_raw WHERE rn = 1 GROUP BY journal_id
        ),
        journal_trend_raw AS (
          SELECT jr.journal_id, jr.value_float, jr.year
          FROM "Journal_Ranking" jr
          JOIN "Ranking_Metric" rm ON rm.metric_id = jr.metric_id
          WHERE jr.journal_id IN (SELECT journal_id FROM journal_stats)
            AND rm.code = 'SJR'
            ${yearFilter}
            AND jr.year >= 2020
        ),
        journal_trends AS (
          SELECT journal_id, STRING_AGG(value_float::text, ',' ORDER BY year ASC) AS trend_str FROM journal_trend_raw GROUP BY journal_id
        ),
        journal_page AS (
          SELECT 
            js.journal_id AS id, j.display_name AS name, COALESCE(p.display_name, 'Unknown') AS publisher,
            COALESCE(j.issn, 'N/A') AS issn, COALESCE(jm.impact_factor, 0) AS "impactFactor",
            COALESCE(jq.sjr_rank, 'Q4') AS "sjrRank", jt.trend_str AS "trendStr",
            js.article_count, COUNT(*) OVER() AS total_count
          FROM journal_stats js
          JOIN "Journal" j ON js.journal_id = j.journal_id
          LEFT JOIN "Publisher" p ON j.publisher_id = p.publisher_id
          LEFT JOIN journal_metrics jm ON js.journal_id = jm.journal_id
          LEFT JOIN journal_quartiles jq ON js.journal_id = jq.journal_id
          LEFT JOIN journal_trends jt ON js.journal_id = jt.journal_id
          WHERE COALESCE(j.is_deleted, false) = false
          ORDER BY "impactFactor" DESC, js.article_count DESC, j.display_name ASC
          LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}
        ),
        distinct_journals AS (SELECT journal_id FROM journal_stats),
        journal_metrics_current AS (
          SELECT jr.journal_id, jr.value_float AS sjr, ROW_NUMBER() OVER(PARTITION BY jr.journal_id ORDER BY jr.year DESC) as rn
          FROM "Journal_Ranking" jr
          JOIN "Ranking_Metric" rm ON rm.metric_id = jr.metric_id
          WHERE jr.journal_id IN (SELECT journal_id FROM distinct_journals) AND rm.code = 'SJR' ${yearFilter}
        ),
        journal_metrics_prev AS (
          SELECT jr.journal_id, jr.value_float AS sjr, ROW_NUMBER() OVER(PARTITION BY jr.journal_id ORDER BY jr.year DESC) as rn
          FROM "Journal_Ranking" jr
          JOIN "Ranking_Metric" rm ON rm.metric_id = jr.metric_id
          WHERE jr.journal_id IN (SELECT journal_id FROM distinct_journals) AND rm.code = 'SJR' ${yearPrevFilter}
        ),
        journal_summary AS (
          SELECT 
            (SELECT AVG(sjr) FROM journal_metrics_current WHERE rn = 1) AS avg_sjr_current,
            (SELECT AVG(sjr) FROM journal_metrics_prev WHERE rn = 1) AS avg_sjr_prev,
            (SELECT COUNT(*) FROM distinct_journals) AS total_journals
        )
        SELECT 
          (SELECT json_agg(row_to_json(jp)) FROM journal_page jp) AS journals,
          (SELECT row_to_json(js) FROM journal_summary js) AS summary;
      `;

      const result = await pool.query(sql, params);
      const row = result.rows[0];
      const journalsData = row.journals || [];
      const summaryData = row.summary || {};
      
      const totalCount = journalsData.length > 0 ? Number(journalsData[0].total_count) : 0;
      
      const journals = journalsData.map(j => ({
        id: j.id,
        name: j.name,
        publisher: j.publisher,
        issn: j.issn,
        impactFactor: Number(j.impactFactor),
        sjrRank: j.sjrRank,
        trend: j.trendStr ? j.trendStr.split(',').map(Number) : []
      }));

      const avgCurrent = Number(summaryData.avg_sjr_current || 0);
      const avgPrev = Number(summaryData.avg_sjr_prev || 0);
      let percentageChange = '+0.0%';
      if (avgPrev > 0) {
        const change = ((avgCurrent - avgPrev) / avgPrev) * 100;
        percentageChange = change >= 0 ? `+${change.toFixed(1)}%` : `${change.toFixed(1)}%`;
      } else if (avgCurrent > 0) {
        percentageChange = '+100.0%';
      }

      return {
        journals,
        pagination: { totalCount, page: pageNum, limit: limitNum, totalPages: Math.ceil(totalCount / limitNum) },
        summary: {
          averageImpactFactor: Math.round(avgCurrent * 100) / 100,
          percentageChange,
          trackedCount: Number(summaryData.total_journals || 0),
          limit: 150
        }
      };
    } catch (error) {
      logger.error('Error fetching journal ranking:', error);
      if (error.status) throw error;
      throw new Error('An internal error occurred while fetching journal ranking.');
    }
  })();

  await redisSet(cacheKey, JSON.stringify(result), CACHE_TTL).catch(e => console.warn(e));
  return result;
}
