import pool from '../../config/database.js';
import logger from '../../utils/logger.js';
import { fetchWithCache } from '../analytics/cache.service.js';
import { getResolvedScope } from '../analytics/scope.repository.js';

const CACHE_KEY_PREFIX = 'analytics:journal-impact:v2';
const CACHE_TTL = 43200; // 12 hours

export async function getImpactMatrixData(query) {
  let { project_id, subject_area, keywords, year } = query;
  year = year || new Date().getFullYear() - 1;

  const queryParams = {
    project_id,
    domain: subject_area,
    subject_category: keywords
  };

  const scope = await getResolvedScope(queryParams);
  const cacheKey = `${CACHE_KEY_PREFIX}:${scope.resolvedProjectId || 'all'}:${scope.mappedDomain}:${scope.projectCategoryIds.join(',')}:${year}`;

  return fetchWithCache(cacheKey, CACHE_TTL, async () => {
    try {
      let params = [];
      let articleFilter = '';

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
            UNION
            SELECT a.issue_id, a.article_id
            FROM "Sub_Topic" st
            JOIN "Article" a ON st.article_id = a.article_id
            WHERE st.topic_id IN (SELECT topic_id FROM target_topics)
              AND coalesce(a.is_deleted, false) = false
          ),
          issue_counts AS (
            SELECT issue_id, COUNT(DISTINCT article_id) AS cnt
            FROM project_articles_issues
            GROUP BY issue_id
          ),
          distinct_journals AS (
            SELECT DISTINCT v.journal_id
            FROM issue_counts ic
            JOIN "Issue" i ON ic.issue_id = i.issue_id
            JOIN "Volume" v ON i.volume_id = v.volume_id
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
            UNION
            SELECT a.issue_id, a.article_id
            FROM "Sub_Topic" st
            JOIN "Article" a ON st.article_id = a.article_id
            WHERE st.topic_id IN (SELECT topic_id FROM target_topics)
              AND coalesce(a.is_deleted, false) = false
          ),
          issue_counts AS (
            SELECT issue_id, COUNT(DISTINCT article_id) AS cnt
            FROM project_articles_issues
            GROUP BY issue_id
          ),
          distinct_journals AS (
            SELECT DISTINCT v.journal_id
            FROM issue_counts ic
            JOIN "Issue" i ON ic.issue_id = i.issue_id
            JOIN "Volume" v ON i.volume_id = v.volume_id
          )
        `;
        params.push(scope.mappedDomain);
      } else {
        articleFilter = `
          WITH issue_counts AS (
            SELECT issue_id, COUNT(article_id) AS cnt
            FROM "Article" a
            WHERE coalesce(a.is_deleted, false) = false
            GROUP BY issue_id
          ),
          distinct_journals AS (
            SELECT DISTINCT v.journal_id
            FROM issue_counts ic
            JOIN "Issue" i ON ic.issue_id = i.issue_id
            JOIN "Volume" v ON i.volume_id = v.volume_id
          )
        `;
      }

      params.push(Number(year));
      const yearIdx = params.length;

      const sql = `
        ${articleFilter},
        metrics_sjr AS (
          SELECT jr.journal_id, jr.value_float AS sjr
          FROM "Journal_Ranking" jr
          JOIN "Ranking_Metric" rm ON jr.metric_id = rm.metric_id
          WHERE jr.journal_id IN (SELECT journal_id FROM distinct_journals)
            AND rm.code = 'SJR'
            AND jr.year = $${yearIdx}
        ),
        metrics_hindex AS (
          SELECT jr.journal_id, jr.value_int AS h_index
          FROM "Journal_Ranking" jr
          JOIN "Ranking_Metric" rm ON jr.metric_id = rm.metric_id
          WHERE jr.journal_id IN (SELECT journal_id FROM distinct_journals)
            AND rm.code = 'H_INDEX'
            AND jr.year = $${yearIdx}
        )
        SELECT 
          dj.journal_id,
          j.display_name AS name,
          COALESCE(s.sjr, 0) AS sjr,
          COALESCE(h.h_index, 0) AS h_index
        FROM distinct_journals dj
        JOIN "Journal" j ON dj.journal_id = j.journal_id
        LEFT JOIN metrics_sjr s ON dj.journal_id = s.journal_id
        LEFT JOIN metrics_hindex h ON dj.journal_id = h.journal_id
        WHERE COALESCE(j.is_deleted, false) = false
          AND s.sjr > 0 
          AND h.h_index > 0
      `;

      const result = await pool.query(sql, params);
      const items = result.rows.map(r => ({
        id: r.journal_id,
        name: r.name,
        sjr: Number(r.sjr),
        h_index: Number(r.h_index)
      }));

      return { items };
    } catch (error) {
      logger.error('Error fetching journal impact matrix:', error);
      if (error.status) throw error;
      throw new Error('Internal server error while fetching impact matrix');
    }
  });
}
