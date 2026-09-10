import pool from '../../../../config/database.js';
import { fetchWithCache } from './cache.service.js';
import logger from '../../../../utils/logger.js';

const CITATION_TTL = 900; // 15 mins

export async function getCitationMirroringData(scope, timeframeQuery, zone = '') {
  const normZone = (zone || '').trim().toLowerCase();
  const hasZone = normZone && normZone !== 'all' && normZone !== 'global' && normZone !== 'global distribution';
  const cacheKey = `analytics:citations:v5:${scope.resolvedProjectId || 'all'}:${scope.mappedDomain}:${scope.projectCategoryIds.join(',')}:${timeframeQuery.from_year}:${timeframeQuery.to_year}:${normZone || 'global'}`;
  
  return fetchWithCache(cacheKey, CITATION_TTL, async () => {
    const { from_year, to_year } = timeframeQuery;
    const mirroringMap = {};
    for (let y = from_year; y <= to_year; y++) {
      mirroringMap[y] = { year: y, external: 0, self: 0 };
    }

    try {
      let targetZoneId = null;
      if (hasZone) {
        const zoneRes = await pool.query(
          `SELECT zone_id FROM "Zone" WHERE LOWER(name) = LOWER($1) OR LOWER(code) = LOWER($1) LIMIT 1`,
          [zone.trim()]
        );
        if (zoneRes.rows.length > 0) {
          targetZoneId = Number(zoneRes.rows[0].zone_id);
        }
      }

      let params = [];
      let sql = '';

      if (targetZoneId) {
        let topicFilterSql = '';
        if (scope.hasProject && scope.projectCategoryIds.length > 0) {
          params.push(scope.projectCategoryIds, targetZoneId, from_year, to_year);
          topicFilterSql = `a.primary_topic IN (SELECT topic_id FROM "Topic" WHERE subject_category_id = ANY($1::bigint[]))`;
        } else if (scope.mappedDomain && scope.mappedDomain !== 'all') {
          params.push(scope.mappedDomain, targetZoneId, from_year, to_year);
          topicFilterSql = `a.primary_topic IN (
            SELECT t.topic_id FROM "Topic" t
            JOIN "Subject_Category" sc ON t.subject_category_id = sc.subject_category_id
            JOIN "Subject_Area" sa ON sc.subject_area_id = sa.subject_area_id
            WHERE LOWER(sa.display_name) = LOWER($1)
          )`;
        } else {
          params.push(targetZoneId, from_year, to_year);
          topicFilterSql = '1=1';
        }

        const zIdx = params.length - 2;
        const fyIdx = params.length - 1;
        const tyIdx = params.length;

        sql = `
          SELECT 
            a.publication_year AS year,
            COUNT(*)::integer AS total_count,
            COALESCE(SUM(a.citation_count), 0)::integer AS total_citations
          FROM "Article" a
          JOIN "Issue" i ON a.issue_id = i.issue_id
          JOIN "Volume" v ON i.volume_id = v.volume_id
          JOIN "Journal" j ON v.journal_id = j.journal_id
          WHERE (j.region = $${zIdx} OR j.country = $${zIdx})
            AND ${topicFilterSql}
            AND a.publication_year >= $${fyIdx} AND a.publication_year <= $${tyIdx}
          GROUP BY a.publication_year
        `;
      } else {
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

        sql = `
          SELECT 
            aty.year AS year,
            SUM(aty.article_count)::integer AS total_count,
            SUM(aty.citation_count)::integer AS total_citations
          FROM "analytics_topic_year" aty
          ${joins}
          WHERE ${condition}
          GROUP BY aty.year
        `;
      }

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
