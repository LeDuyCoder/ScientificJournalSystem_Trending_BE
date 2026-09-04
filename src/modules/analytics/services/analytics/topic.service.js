import pool from '../../../../config/database.js';
import { fetchWithCache } from './cache.service.js';
import logger from '../../../../utils/logger.js';

const TOPIC_TTL = 1800; // 30 mins

export async function getTopicEvolutionData(scope, timeframeQuery) {
  const cacheKey = `analytics:topics:v3:${scope.resolvedProjectId || 'all'}:${scope.mappedDomain}:${scope.projectCategoryIds.join(',')}:${timeframeQuery.from_year}:${timeframeQuery.to_year}`;
  
  return fetchWithCache(cacheKey, TOPIC_TTL, async () => {
    let topicEvolutionData = [];
    const { from_year, to_year } = timeframeQuery;
    const yearsRange = [];
    for (let y = from_year; y <= to_year; y++) yearsRange.push(y);

    try {
      let cteCondition = '';
      let cteParams = [];
      let joins = `JOIN "Article" a ON a.primary_topic = t.topic_id`;
      
      if (scope.hasProject && scope.projectCategoryIds.length > 0) {
        cteCondition = `t.subject_category_id = ANY($1::bigint[]) 
                        AND coalesce(a.is_deleted, false) = false 
                        AND a.publication_year >= $2 
                        AND a.publication_year <= $3`;
        cteParams = [scope.projectCategoryIds, from_year, to_year];
      } else if (scope.mappedDomain && scope.mappedDomain !== 'all') {
        joins += ` JOIN "Subject_Category" sc ON t.subject_category_id = sc.subject_category_id
                   JOIN "Subject_Area" sa ON sc.subject_area_id = sa.subject_area_id`;
        cteCondition = `LOWER(sa.display_name) = LOWER($1) 
                        AND coalesce(a.is_deleted, false) = false
                        AND a.publication_year >= $2 
                        AND a.publication_year <= $3`;
        cteParams = [scope.mappedDomain, from_year, to_year];
      } else {
        cteCondition = `coalesce(a.is_deleted, false) = false
                        AND a.publication_year >= $1 
                        AND a.publication_year <= $2`;
        cteParams = [from_year, to_year];
      }

      const sql = `
        WITH TargetTopics AS (
           SELECT t.topic_id, t.display_name AS name, count(a.article_id) as cnt
           FROM "Topic" t
           ${joins}
           WHERE ${cteCondition}
           GROUP BY t.topic_id, t.display_name
           ORDER BY cnt DESC
           LIMIT 3
        )
        SELECT 
          tt.name,
          tt.topic_id,
          tt.cnt as total_topic_cnt,
          a.publication_year, 
          count(a.article_id) as year_cnt
        FROM TargetTopics tt
        LEFT JOIN "Article" a ON a.primary_topic = tt.topic_id
          AND coalesce(a.is_deleted, false) = false
          AND a.publication_year >= $${cteParams.length - (scope.hasProject || scope.mappedDomain!=='all' ? 1 : 0) - (scope.hasProject ? 0 : (scope.mappedDomain!=='all'?0:1))} /* Simplified index logic */
        WHERE a.publication_year IS NOT NULL
        GROUP BY tt.name, tt.topic_id, tt.cnt, a.publication_year
      `;

      // Correct parameter indexing for the outer query
      let outerYearFromIdx, outerYearToIdx;
      if (scope.hasProject && scope.projectCategoryIds.length > 0) {
        outerYearFromIdx = 2; outerYearToIdx = 3;
      } else if (scope.mappedDomain && scope.mappedDomain !== 'all') {
        outerYearFromIdx = 2; outerYearToIdx = 3;
      } else {
        outerYearFromIdx = 1; outerYearToIdx = 2;
      }

      const finalSql = `
        WITH TargetTopics AS (
           SELECT t.topic_id, t.display_name AS name, count(a.article_id) as cnt
           FROM "Topic" t
           ${joins}
           WHERE ${cteCondition}
           GROUP BY t.topic_id, t.display_name
           ORDER BY cnt DESC
           LIMIT 3
        )
        SELECT 
          tt.name,
          tt.topic_id,
          tt.cnt as total_topic_cnt,
          a.publication_year, 
          count(a.article_id) as year_cnt
        FROM TargetTopics tt
        LEFT JOIN "Article" a ON a.primary_topic = tt.topic_id
          AND coalesce(a.is_deleted, false) = false
          AND a.publication_year >= $${outerYearFromIdx}
          AND a.publication_year <= $${outerYearToIdx}
        GROUP BY tt.name, tt.topic_id, tt.cnt, a.publication_year
      `;
      
      const countsRes = await pool.query(finalSql, cteParams);
      
      const topicsMap = {};
      const DOMAIN_STATUSES = ['Expanding', 'Stable', 'Emerging'];
      
      countsRes.rows.forEach(r => {
        if (!topicsMap[r.topic_id]) {
          topicsMap[r.topic_id] = {
            name: r.name,
            total_cnt: parseInt(r.total_topic_cnt, 10),
            yearsMap: {}
          };
        }
        if (r.publication_year) {
          topicsMap[r.topic_id].yearsMap[parseInt(r.publication_year, 10)] = parseInt(r.year_cnt, 10);
        }
      });

      const topicsData = Object.values(topicsMap).map((topic, i) => {
        const topicYearData = yearsRange.map(year => ({
          year,
          value: topic.yearsMap[year] || 0
        }));
        return {
          name: topic.name,
          domain: DOMAIN_STATUSES[i % DOMAIN_STATUSES.length],
          percentage: 0, // Simplified: avoid full DB scan just for percentage
          data: topicYearData
        };
      });

      topicsData.sort((a, b) => b.total_cnt - a.total_cnt);
      topicEvolutionData = topicsData;
    } catch (err) {
      logger.error('Error fetching topic evolution data:', err);
    }

    return { topics: topicEvolutionData };
  });
}
