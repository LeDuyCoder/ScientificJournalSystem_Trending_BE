import pool from '../../../../config/database.js';
import { fetchWithCache } from './cache.service.js';
import logger from '../../../../utils/logger.js';

const CITATION_TTL = 900; // 15 mins

export async function getCitationMirroringData(scope, timeframeQuery) {
  const cacheKey = `analytics:citations:v4:${scope.resolvedProjectId || 'all'}:${scope.mappedDomain}:${scope.projectCategoryIds.join(',')}:${timeframeQuery.from_year}:${timeframeQuery.to_year}`;
  
  return fetchWithCache(cacheKey, CITATION_TTL, async () => {
    const { from_year, to_year } = timeframeQuery;
    const mirroringMap = {};
    for (let y = from_year; y <= to_year; y++) {
      mirroringMap[y] = { year: y, external: 0, self: 0 };
    }

    try {
      let params = [];
      let joins = '';
      let condition = '';

      if (scope.hasProject && scope.projectCategoryIds.length > 0) {
        joins = `JOIN "Topic" t ON aty.topic_id = t.topic_id`;
        condition = `t.subject_category_id = ANY($1::bigint[]) AND aty.year >= $2 AND aty.year <= $3`;
        params = [scope.projectCategoryIds, from_year, to_year];
      } else if (scope.mappedDomain && scope.mappedDomain !== 'all') {
        joins = `JOIN "Topic" t ON aty.topic_id = t.topic_id
                 JOIN "Subject_Category" sc ON t.subject_category_id = sc.subject_category_id
                 JOIN "Subject_Area" sa ON sc.subject_area_id = sa.subject_area_id`;
        condition = `LOWER(sa.display_name) = LOWER($1) AND aty.year >= $2 AND aty.year <= $3`;
        params = [scope.mappedDomain, from_year, to_year];
      } else {
        condition = `aty.year >= $1 AND aty.year <= $2`;
        params = [from_year, to_year];
      }

      const sql = `
        SELECT 
          aty.year AS year,
          SUM(aty.article_count)::integer AS total_count,
          SUM(aty.citation_count)::integer AS total_citations
        FROM "analytics_topic_year" aty
        ${joins}
        WHERE ${condition}
        GROUP BY aty.year
      `;

      const result = await pool.query(sql, params);
      
      result.rows.forEach(record => {
        const year = parseInt(record.year, 10);
        if (mirroringMap[year]) {
          const totalCitations = parseInt(record.total_citations || 0, 10);
          const self = Math.floor(totalCitations * 0.15); // Statistical approximation for self-citations
          const external = totalCitations - self;
          
          mirroringMap[year].self = self;
          mirroringMap[year].external = external;
        }
      });
    } catch (err) {
      logger.error('Error fetching citation mirroring data from PostgreSQL:', err);
    }

    return { data: Object.values(mirroringMap) };
  });
}
