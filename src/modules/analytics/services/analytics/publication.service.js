import pool from '../../../../config/database.js';
import { fetchWithCache } from './cache.service.js';
import logger from '../../../../utils/logger.js';

const PUB_TTL = 900; // 15 mins

function calcGrowthRate(current, previous) {
  if (!previous) return 0;
  const rate = ((current - previous) / previous) * 100;
  return Math.round(rate * 10) / 10;
}

export async function getPublicationTrendsData(scope, timeframeQuery) {
  const cacheKey = `analytics:pubtrends:v6:${scope.resolvedProjectId || 'all'}:${scope.mappedDomain}:${scope.projectCategoryIds.join(',')}:${timeframeQuery.from_year}:${timeframeQuery.to_year}`;
  
  return fetchWithCache(cacheKey, PUB_TTL, async () => {
    let growthRate = 0;
    const { from_year, to_year } = timeframeQuery;
    const yearsRange = [];
    for (let y = from_year; y <= to_year; y++) yearsRange.push(y);
    
    let publicationTrendData = yearsRange.map(year => ({ year, value: 0 }));

    try {
      let params = [];
      let sql = '';

      if (scope.hasProject && scope.projectCategoryIds.length > 0) {
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
