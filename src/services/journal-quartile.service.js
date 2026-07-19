import pool from '../config/database.js';
import logger from '../utils/logger.js';
import { fetchWithCache } from './analytics/cache.service.js';
import { getResolvedScope } from './analytics/scope.repository.js';

const CACHE_KEY_PREFIX = 'analytics:journal-quartiles:v2';
const CACHE_TTL = 43200; // 12 hours

export async function getJournalQuartileDistribution(query) {
  let { project_id, subject_area, keywords, from_year, to_year } = query;
  
  from_year = from_year || 2024;
  to_year = to_year || 2026;

  const queryParams = {
    project_id,
    domain: subject_area,
    subject_category: keywords
  };

  const scope = await getResolvedScope(queryParams);
  const cacheKey = `${CACHE_KEY_PREFIX}:${scope.resolvedProjectId || 'all'}:${scope.mappedDomain}:${scope.projectCategoryIds.join(',')}:${from_year}:${to_year}`;

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

      params.push(Number(from_year), Number(to_year));
      const fromParamIdx = params.length - 1;
      const toParamIdx = params.length;

      const sql = `
        ${articleFilter},
        journal_quartiles_raw AS (
          SELECT 
            jr.journal_id,
            jr.value_txt AS quartile,
            jr.year,
            ROW_NUMBER() OVER(PARTITION BY jr.journal_id, jr.year ORDER BY jr.year DESC) as rn
          FROM "Journal_Ranking" jr
          JOIN "Ranking_Metric" rm ON rm.metric_id = jr.metric_id
          WHERE jr.journal_id IN (SELECT journal_id FROM distinct_journals)
            AND rm.metric_type = 'QUARTILE'
            AND jr.value_txt IN ('Q1', 'Q2', 'Q3', 'Q4')
            AND jr.year >= $${fromParamIdx}
            AND jr.year <= $${toParamIdx}
        ),
        yearly_distribution AS (
          SELECT year, quartile, COUNT(DISTINCT journal_id) as count
          FROM journal_quartiles_raw
          WHERE rn = 1
          GROUP BY year, quartile
        )
        SELECT year, quartile, count
        FROM yearly_distribution
        ORDER BY year ASC, quartile ASC;
      `;

      const result = await pool.query(sql, params);
      const rows = result.rows;

      const distributions = [];
      const years = Array.from({ length: to_year - from_year + 1 }, (_, i) => Number(from_year) + i);

      for (const year of years) {
        const yearData = {
          year: year.toString(),
          Q1: 0,
          Q2: 0,
          Q3: 0,
          Q4: 0,
          total: 0
        };

        const currentYearRows = rows.filter(r => Number(r.year) === year);
        for (const row of currentYearRows) {
          const q = row.quartile;
          const count = Number(row.count);
          yearData[q] = count;
          yearData.total += count;
        }

        distributions.push(yearData);
      }

      return {
        distributions
      };

    } catch (error) {
      logger.error('Error fetching journal quartile distribution:', error);
      if (error.status) throw error;
      throw new Error('Internal server error while fetching journal quartile distribution');
    }
  });
}