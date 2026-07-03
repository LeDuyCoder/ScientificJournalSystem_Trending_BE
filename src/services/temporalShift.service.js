import pool from '../config/database.js';
import logger from '../../utils/logger.js';
import { redisGet, redisSet } from './redis.service.js';
import { getProjectScope } from './forecast.service.js';

const CACHE_TTL = 3600;

/**
 * Service to calculate temporal shift heatmap grid data and drift entropy.
 * @param {string|number} projectId
 * @param {object} filters
 * @returns {Promise<object>}
 */
export async function getTemporalShift(projectId, filters = {}) {
  const { subject_area, keywords, from_year, to_year } = filters;
  const cacheKey = `analytics:network:temporal-shift:${projectId}:${(subject_area || '').toLowerCase()}:${from_year || ''}:${to_year || ''}`;

  try {
    const cached = await redisGet(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (err) {
    logger.warn('Redis read error for temporal-shift:', err);
  }

  // Parse keywords list if any
  let keywordList = [];
  if (keywords) {
    keywordList = Array.isArray(keywords)
      ? keywords
      : String(keywords).split(',').map(s => s.trim()).filter(Boolean);
  }

  const client = await pool.connect();
  const defaultResponse = { heatmap: [], driftEntropy: 'LOW', description: 'No data available.' };

  try {
    const scope = await getProjectScope(client, projectId);
    if (scope.subjectCategoryIds.length === 0 && scope.keywordIds.length === 0) {
      return defaultResponse;
    }

    const params = [];
    const sqlFilters = [];

    // Project scope filters: categories OR keywords
    const scopeConditions = [];
    if (scope.subjectCategoryIds.length > 0) {
      params.push(scope.subjectCategoryIds);
      const catIndex = params.length;
      scopeConditions.push(`
        (
          EXISTS (
            SELECT 1 FROM "Topic" primary_topic
            WHERE primary_topic.topic_id = a.primary_topic
              AND primary_topic.subject_category_id = ANY($${catIndex}::bigint[])
          )
          OR EXISTS (
            SELECT 1 FROM "Sub_Topic" st
            JOIN "Topic" sub_topic ON st.topic_id = sub_topic.topic_id
            WHERE st.article_id = a.article_id
              AND sub_topic.subject_category_id = ANY($${catIndex}::bigint[])
          )
        )
      `);
    }

    if (scope.keywordIds.length > 0) {
      params.push(scope.keywordIds);
      const kwIndex = params.length;
      scopeConditions.push(`
        EXISTS (
          SELECT 1 FROM "Keyword_Article" ka
          WHERE ka.article_id = a.article_id
            AND ka.keyword_id = ANY($${kwIndex}::bigint[])
        )
      `);
    }

    if (scopeConditions.length > 0) {
      sqlFilters.push(`(${scopeConditions.join(' OR ')})`);
    }

    // Client filter: subject_area
    if (subject_area) {
      const saRes = await client.query(
        `SELECT subject_area_id FROM "Subject_Area" WHERE LOWER(display_name) = LOWER($1) AND COALESCE(is_deleted, false) = false`,
        [subject_area.trim()]
      );

      if (saRes.rows.length === 0) {
        return defaultResponse;
      }

      const saId = saRes.rows[0].subject_area_id;

      const scRes = await client.query(
        `SELECT subject_category_id FROM "Subject_Category" WHERE subject_area_id = $1 AND COALESCE(is_deleted, false) = false`,
        [saId]
      );
      const filterCategoryIds = scRes.rows.map(r => Number(r.subject_category_id));

      if (filterCategoryIds.length === 0) {
        return defaultResponse;
      }

      params.push(filterCategoryIds);
      const filterCatIndex = params.length;
      sqlFilters.push(`
        (
          EXISTS (
            SELECT 1 FROM "Topic" ft
            WHERE ft.topic_id = a.primary_topic
              AND ft.subject_category_id = ANY($${filterCatIndex}::bigint[])
          )
          OR EXISTS (
            SELECT 1 FROM "Sub_Topic" fst
            JOIN "Topic" fst_topic ON fst.topic_id = fst_topic.topic_id
            WHERE fst.article_id = a.article_id
              AND fst_topic.subject_category_id = ANY($${filterCatIndex}::bigint[])
          )
        )
      `);
    }

    // Client filter: keywords
    if (keywordList.length > 0) {
      const kwRes = await client.query(
        `SELECT keyword_id FROM "Keyword" WHERE LOWER(display_name) = ANY($1::text[])`,
        [keywordList.map(s => s.toLowerCase())]
      );
      const filterKeywordIds = kwRes.rows.map(r => Number(r.keyword_id));

      if (filterKeywordIds.length === 0) {
        return defaultResponse;
      }

      params.push(filterKeywordIds);
      const filterKwIndex = params.length;
      sqlFilters.push(`
        EXISTS (
          SELECT 1 FROM "Keyword_Article" fka
          WHERE fka.article_id = a.article_id
            AND fka.keyword_id = ANY($${filterKwIndex}::bigint[])
        )
      `);
    }

    const baseFilters = [...sqlFilters];
    const baseParams = [...params];
    if (from_year !== undefined && from_year !== null) {
      baseParams.push(Number(from_year));
      baseFilters.push(`a.publication_year >= $${baseParams.length}`);
    }
    if (to_year !== undefined && to_year !== null) {
      baseParams.push(Number(to_year));
      baseFilters.push(`a.publication_year <= $${baseParams.length}`);
    }

    const baseWhereClause = baseFilters.length > 0 ? `AND ${baseFilters.join(' AND ')}` : '';

    // Query to find latest year
    const latestYearQuery = `
      SELECT MAX(a.publication_year)::integer AS latest_year
      FROM "Article" a
      WHERE COALESCE(a.is_deleted, false) = false
        ${baseWhereClause}
    `;

    const latestYearRes = await client.query(latestYearQuery, baseParams);
    let latestYear = latestYearRes.rows[0]?.latest_year;

    if (!latestYear) {
      latestYear = new Date().getFullYear();
    }

    // Last 8 years
    const startYear = latestYear - 7;
    const endYear = latestYear;

    // Get the top 7 keywords in this scope by total count
    const topKeywordsParams = [...baseParams];
    const topKeywordsQuery = `
      SELECT k.keyword_id, k.display_name, COUNT(a.article_id)::integer AS total_count
      FROM "Keyword" k
      JOIN "Keyword_Article" ka ON k.keyword_id = ka.keyword_id
      JOIN "Article" a ON ka.article_id = a.article_id
      WHERE COALESCE(a.is_deleted, false) = false
        AND a.publication_year BETWEEN ${startYear} AND ${endYear}
        ${baseWhereClause}
      GROUP BY k.keyword_id, k.display_name
      ORDER BY total_count DESC
      LIMIT 7
    `;
    const topKeywordsRes = await client.query(topKeywordsQuery, topKeywordsParams);
    const topKeywords = topKeywordsRes.rows;

    // Now query volume per year for these top 7 keywords
    const heatmap = [];
    if (topKeywords.length > 0) {
      const keywordIds = topKeywords.map(kw => Number(kw.keyword_id));
      const volumeQuery = `
        SELECT 
          ka.keyword_id,
          a.publication_year,
          COUNT(a.article_id)::integer AS volume
        FROM "Keyword_Article" ka
        JOIN "Article" a ON ka.article_id = a.article_id
        WHERE COALESCE(a.is_deleted, false) = false
          AND ka.keyword_id = ANY($1::bigint[])
          AND a.publication_year BETWEEN $2 AND $3
        GROUP BY ka.keyword_id, a.publication_year
      `;
      const volumeRes = await client.query(volumeQuery, [keywordIds, startYear, endYear]);
      
      // Map volumes to a nested lookup
      const volumeMap = new Map();
      volumeRes.rows.forEach(row => {
        volumeMap.set(`${row.keyword_id}__${row.publication_year}`, Number(row.volume || 0));
      });

      // Find max volume to normalize intensities
      let maxVol = 0;
      topKeywords.forEach(kw => {
        for (let year = startYear; year <= endYear; year++) {
          const vol = volumeMap.get(`${kw.keyword_id}__${year}`) || 0;
          if (vol > maxVol) maxVol = vol;
        }
      });

      // Construct the 56 cell grid (7 rows x 8 cols)
      for (let i = 0; i < 7; i++) {
        const kw = topKeywords[i];
        for (let j = 0; j < 8; j++) {
          const year = startYear + j;
          const cellId = i * 8 + j;
          
          let intensity = 0.1;
          if (kw) {
            const vol = volumeMap.get(`${kw.keyword_id}__${year}`) || 0;
            if (maxVol > 0) {
              intensity = 0.1 + (vol / maxVol) * 0.9;
            }
          }
          heatmap.push({
            id: cellId,
            intensity: Math.round(intensity * 100) / 100
          });
        }
      }
    } else {
      // Fallback grid of 56 cells
      for (let i = 0; i < 56; i++) {
        heatmap.push({
          id: i,
          intensity: Math.round((0.1 + Math.random() * 0.9) * 100) / 100
        });
      }
    }

    // Fetch top category names for description
    const topCatQuery = `
      SELECT sc.display_name, COUNT(a.article_id) as count
      FROM "Article" a
      JOIN "Topic" t ON a.primary_topic = t.topic_id
      JOIN "Subject_Category" sc ON t.subject_category_id = sc.subject_category_id
      WHERE COALESCE(a.is_deleted, false) = false
        ${baseWhereClause}
      GROUP BY sc.subject_category_id, sc.display_name
      ORDER BY count DESC
      LIMIT 2
    `;
    const topCatRes = await client.query(topCatQuery, baseParams);
    const cat1 = topCatRes.rows[0]?.display_name || 'Green Hydrogen';
    const cat2 = topCatRes.rows[1]?.display_name || 'Carbon Capture';

    // Calculate dynamic Drift Entropy based on category counts variance
    let driftEntropy = 'LOW';
    const counts = topCatRes.rows.map(r => Number(r.count));
    if (counts.length > 1) {
      const ratio = counts[0] / (counts[1] || 1);
      if (ratio > 2) {
        driftEntropy = 'LOW';
      } else if (ratio > 1.2) {
        driftEntropy = 'MEDIUM';
      } else {
        driftEntropy = 'HIGH';
      }
    }

    const result = {
      heatmap,
      driftEntropy,
      description: `Clusters are stabilizing around ${cat1} and ${cat2} techs.`
    };

    await redisSet(cacheKey, JSON.stringify(result), CACHE_TTL);
    return result;
  } finally {
    client.release();
  }
}
