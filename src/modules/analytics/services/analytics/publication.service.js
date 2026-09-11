import pool from '../../../../config/database.js';
import { fetchWithCache } from './cache.service.js';
import logger from '../../../../utils/logger.js';

const PUB_TTL = 900; // 15 mins

function calcGrowthRate(current, previous) {
  if (!previous) return 0;
  const rate = ((current - previous) / previous) * 100;
  return Math.round(rate * 10) / 10;
}

export async function getPublicationTrendsData(scope, timeframeQuery, zone = '') {
  const normZone = (zone || '').trim().toLowerCase();
  const hasZone = normZone && normZone !== 'all' && normZone !== 'global' && normZone !== 'global distribution';
  const cacheKey = `analytics:pubtrends:v7:${scope.resolvedProjectId || 'all'}:${scope.mappedDomain}:${scope.projectCategoryIds.join(',')}:${timeframeQuery.from_year}:${timeframeQuery.to_year}:${normZone || 'global'}`;
  
  return fetchWithCache(cacheKey, PUB_TTL, async () => {
    let growthRate = 0;
    const { from_year, to_year } = timeframeQuery;
    const yearsRange = [];
    for (let y = from_year; y <= to_year; y++) yearsRange.push(y);
    
    let publicationTrendData = yearsRange.map(year => ({ year, value: 0 }));

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
          SELECT a.publication_year AS year, COUNT(*)::integer AS articles
          FROM "Article" a
          JOIN "Issue" i ON a.issue_id = i.issue_id
          JOIN "Volume" v ON i.volume_id = v.volume_id
          JOIN "Journal" j ON v.journal_id = j.journal_id
          WHERE (j.region = $${zIdx} OR j.country = $${zIdx})
            AND ${topicFilterSql}
            AND a.publication_year >= $${fyIdx} AND a.publication_year <= $${tyIdx}
          GROUP BY a.publication_year
          ORDER BY year ASC
        `;
      } else if (scope.hasProject && scope.projectCategoryIds.length > 0) {
        params.push(scope.projectCategoryIds, from_year, to_year);
        sql = `
          WITH target_topics AS (
            SELECT topic_id FROM "Topic" WHERE subject_category_id = ANY($1::bigint[])
          )
          SELECT year, SUM(article_count)::integer AS articles
          FROM "analytics_topic_year"
          WHERE topic_id IN (SELECT topic_id FROM target_topics)
            AND year >= $2 AND year <= $3
          GROUP BY year
          ORDER BY year ASC
        `;
      } else if (scope.mappedDomain && scope.mappedDomain !== 'all') {
        params.push(scope.mappedDomain, from_year, to_year);
        sql = `
          WITH target_topics AS (
            SELECT t.topic_id FROM "Topic" t
            JOIN "Subject_Category" sc ON t.subject_category_id = sc.subject_category_id
            JOIN "Subject_Area" sa ON sc.subject_area_id = sa.subject_area_id
            WHERE LOWER(sa.display_name) = LOWER($1)
          )
          SELECT year, SUM(article_count)::integer AS articles
          FROM "analytics_topic_year"
          WHERE topic_id IN (SELECT topic_id FROM target_topics)
            AND year >= $2 AND year <= $3
          GROUP BY year
          ORDER BY year ASC
        `;
      } else {
        params.push(from_year, to_year);
        sql = `
          SELECT year, SUM(article_count)::integer AS articles
          FROM "analytics_topic_year"
          WHERE year >= $1 AND year <= $2
          GROUP BY year
          ORDER BY year ASC
        `;
      }

      const res = await pool.query(sql, params);
      
      const map = {};
      res.rows.forEach(r => {
        map[parseInt(r.year, 10)] = parseInt(r.articles, 10);
      });

      publicationTrendData = yearsRange.map(year => ({
        year,
        value: map[year] || 0
      }));

      if (publicationTrendData.length >= 2) {
        const currentVal = publicationTrendData[publicationTrendData.length - 1].value;
        const previousVal = publicationTrendData[publicationTrendData.length - 2].value;
        growthRate = calcGrowthRate(currentVal, previousVal);
      }
    } catch (err) {
      logger.error('Error in publication trends data:', err);
    }

    return {
      growthRate,
      unit: 'YoY',
      data: publicationTrendData
    };
  });
}
