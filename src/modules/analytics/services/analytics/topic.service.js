import pool from '../../../../config/database.js';
import { fetchWithCache } from './cache.service.js';
import logger from '../../../../utils/logger.js';

const TOPIC_TTL = 1800; // 30 mins

export async function getTopicEvolutionData(scope, timeframeQuery) {
  const cacheKey = `analytics:topics:v4:${scope.resolvedProjectId || 'all'}:${scope.mappedDomain}:${scope.projectCategoryIds.join(',')}:${timeframeQuery.from_year}:${timeframeQuery.to_year}`;
  
  return fetchWithCache(cacheKey, TOPIC_TTL, async () => {
    let topicEvolutionData = [];
    const { from_year, to_year } = timeframeQuery;
    const yearsRange = [];
    for (let y = from_year; y <= to_year; y++) yearsRange.push(y);

    try {
      let cteCondition = '';
      let cteParams = [];
      let joins = '';
      
      if (scope.hasProject && scope.projectCategoryIds.length > 0) {
        cteCondition = `t.subject_category_id = ANY($1::bigint[]) 
                        AND aty.year >= $2 
                        AND aty.year <= $3`;
        cteParams = [scope.projectCategoryIds, from_year, to_year];
      } else if (scope.mappedDomain && scope.mappedDomain !== 'all') {
        joins = ` JOIN "Subject_Category" sc ON t.subject_category_id = sc.subject_category_id
                  JOIN "Subject_Area" sa ON sc.subject_area_id = sa.subject_area_id`;
        cteCondition = `LOWER(sa.display_name) = LOWER($1) 
                        AND aty.year >= $2 
                        AND aty.year <= $3`;
        cteParams = [scope.mappedDomain, from_year, to_year];
      } else {
        cteCondition = `aty.year >= $1 
                        AND aty.year <= $2`;
        cteParams = [from_year, to_year];
      }

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
           SELECT t.topic_id, t.display_name AS name, SUM(aty.article_count) as cnt
           FROM "Topic" t
           JOIN "analytics_topic_year" aty ON t.topic_id = aty.topic_id
           ${joins}
           WHERE ${cteCondition}
           GROUP BY t.topic_id, t.display_name
           ORDER BY cnt DESC NULLS LAST
           LIMIT 3
        )
        SELECT 
          tt.name,
          tt.topic_id,
          tt.cnt as total_topic_cnt,
          aty.year AS publication_year, 
          aty.article_count as year_cnt
        FROM TargetTopics tt
        LEFT JOIN "analytics_topic_year" aty ON aty.topic_id = tt.topic_id
          AND aty.year >= $${outerYearFromIdx}
          AND aty.year <= $${outerYearToIdx}
      `;
      
      const countsRes = await pool.query(finalSql, cteParams);
      
      const topicsMap = {};
      const DOMAIN_STATUSES = ['Expanding', 'Stable', 'Emerging'];
      
      countsRes.rows.forEach(r => {
        if (!topicsMap[r.topic_id]) {
          topicsMap[r.topic_id] = {
            name: r.name,
            total_cnt: parseInt(r.total_topic_cnt || 0, 10),
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
          percentage: 0,
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
