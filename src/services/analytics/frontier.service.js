import pool from '../../config/database.js';
import { fetchWithCache } from './cache.service.js';
import logger from '../../utils/logger.js';

const FRONTIER_TTL = 3600; // 1 hour

export async function getFrontierDetectionData(scope) {
  const cacheKey = `analytics:frontier:v5:${scope.resolvedProjectId || 'all'}:${scope.mappedDomain}:${scope.projectCategoryIds.join(',')}`;
  
  return fetchWithCache(cacheKey, FRONTIER_TTL, async () => {
    let frontierDetectionItems = [];

    try {
      let params = [];
      let cteCondition = '';
      let joins = `JOIN "Article" a ON a.primary_topic = t.topic_id`;
      
      if (scope.hasProject && scope.projectCategoryIds.length > 0) {
        cteCondition = `t.subject_category_id = ANY($1::bigint[]) AND coalesce(a.is_deleted, false) = false`;
        params = [scope.projectCategoryIds];
      } else if (scope.mappedDomain && scope.mappedDomain !== 'all') {
        joins += ` JOIN "Subject_Category" sc ON t.subject_category_id = sc.subject_category_id
                   JOIN "Subject_Area" sa ON sc.subject_area_id = sa.subject_area_id`;
        cteCondition = `LOWER(sa.display_name) = LOWER($1) AND coalesce(a.is_deleted, false) = false`;
        params = [scope.mappedDomain];
      } else {
        cteCondition = `coalesce(a.is_deleted, false) = false`;
      }

      // We calculate rawIF and rawVelocity directly from Postgres
      // rawVelocity = total citations
      // rawIF = total citations / article count
      const sql = `
        SELECT 
          t.display_name AS topic,
          COUNT(a.article_id)::integer AS article_count,
          SUM(COALESCE(a.citation_count, 0))::integer AS citation_count
        FROM "Topic" t
        ${joins}
        WHERE ${cteCondition}
        GROUP BY t.topic_id, t.display_name
        HAVING COUNT(a.article_id) > 0
        ORDER BY (SUM(COALESCE(a.citation_count, 0))::float / COUNT(a.article_id)) DESC
        LIMIT 10
      `;

      const result = await pool.query(sql, params);

      const rawRecords = result.rows.map(r => {
        const articleCount = parseInt(r.article_count, 10);
        const citationCount = parseInt(r.citation_count, 10);
        return {
          topic: r.topic,
          rawIF: citationCount / articleCount,
          rawVelocity: citationCount
        };
      });

      const maxIF = rawRecords.reduce((max, r) => Math.max(max, r.rawIF), 0) || 1.0;
      const scaleIF = 10.0 / maxIF;

      const nonZeroVelocities = rawRecords
        .map(r => r.rawVelocity)
        .filter(v => v > 0)
        .sort((a, b) => a - b);

      frontierDetectionItems = rawRecords.map(record => {
        let impactFactor = record.rawIF * scaleIF;
        if (impactFactor < 0) impactFactor = 0;

        let citationVelocity = 0;
        if (record.rawVelocity > 0) {
          const index = nonZeroVelocities.indexOf(record.rawVelocity);
          const rank = nonZeroVelocities.length > 1
            ? index / (nonZeroVelocities.length - 1)
            : 1.0;
          citationVelocity = 3.0 + rank * 6.5;
        }
        if (citationVelocity < 0) citationVelocity = 0;

        impactFactor = Math.round(impactFactor * 10) / 10;
        citationVelocity = Math.round(citationVelocity * 10) / 10;

        let status = 'emerging';
        if (impactFactor >= 3.0 && citationVelocity >= 5.0) {
          status = 'frontier';
        }

        return {
          label: record.topic,
          impactVelocity: impactFactor,
          citationVelocity: citationVelocity,
          status: status
        };
      });
    } catch (err) {
      logger.error('Error fetching frontier topics from PostgreSQL:', err);
    }

    return { items: frontierDetectionItems };
  });
}
