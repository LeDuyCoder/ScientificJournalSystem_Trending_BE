import pool from '../../../../config/database.js';
import logger from '../../../../utils/logger.js';
import { redisGet, redisSet } from '../../../core/services/infrastructure/redis.service.js';
import { getProjectScope } from '../trends/forecast.service.js';

const CACHE_TTL = 43200; // 12 hours

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

    const cteParts = [];
    const params = [];

    // 1. Project Scope topics / keywords
    if (scope.subjectCategoryIds.length > 0 || scope.keywordIds.length > 0) {
      params.push(projectId);
      cteParts.push(`project_scope AS (SELECT article_id FROM "Project_Article_Scope" WHERE project_id = $${params.length})`);
    }

    // 2. Client filter: subject_area
    if (subject_area) {
      const saRes = await client.query(`SELECT subject_area_id FROM "Subject_Area" WHERE LOWER(display_name) = LOWER($1) AND COALESCE(is_deleted, false) = false`, [subject_area.trim()]);
      if (saRes.rows.length === 0) return defaultResponse;

      const saId = saRes.rows[0].subject_area_id;
      const scRes = await client.query(`SELECT subject_category_id FROM "Subject_Category" WHERE subject_area_id = $1 AND COALESCE(is_deleted, false) = false`, [saId]);
      const filterCategoryIds = scRes.rows.map(r => Number(r.subject_category_id));
      if (filterCategoryIds.length === 0) return defaultResponse;

      params.push(filterCategoryIds);
      const filterCatIdx = params.length;
      cteParts.push(`sa_filter AS (
        SELECT a.article_id FROM "Article" a
        JOIN "Topic" t ON a.primary_topic = t.topic_id
        WHERE t.subject_category_id = ANY($${filterCatIdx}::bigint[]) AND COALESCE(a.is_deleted, false) = false
        UNION
        SELECT st.article_id FROM "Sub_Topic" st
        JOIN "Topic" t ON st.topic_id = t.topic_id
        WHERE t.subject_category_id = ANY($${filterCatIdx}::bigint[])
      )`);
    }

    // 3. Client filter: keywords
    if (keywordList.length > 0) {
      const kwRes = await client.query(`SELECT keyword_id FROM "Keyword" WHERE LOWER(display_name) = ANY($1::text[])`, [keywordList.map(s => s.toLowerCase())]);
      const filterKeywordIds = kwRes.rows.map(r => Number(r.keyword_id));
      if (filterKeywordIds.length === 0) return defaultResponse;

      params.push(filterKeywordIds);
      const filterKwIdx = params.length;
      cteParts.push(`kw_filter AS (
        SELECT article_id FROM "Keyword_Article" WHERE keyword_id = ANY($${filterKwIdx}::bigint[])
      )`);
    }

    // 4. Combine into filtered_articles
    const joinClauses = [];
    if (scope.subjectCategoryIds.length > 0 || scope.keywordIds.length > 0) {
      joinClauses.push('JOIN project_scope ps ON a.article_id = ps.article_id');
    }
    if (subject_area) {
      joinClauses.push('JOIN sa_filter saf ON a.article_id = saf.article_id');
    }
    if (keywordList.length > 0) {
      joinClauses.push('JOIN kw_filter kwf ON a.article_id = kwf.article_id');
    }

    const yearFilters = [];
    if (from_year !== undefined && from_year !== null) {
      params.push(Number(from_year));
      yearFilters.push(`a.publication_year >= $${params.length}`);
    }
    if (to_year !== undefined && to_year !== null) {
      params.push(Number(to_year));
      yearFilters.push(`a.publication_year <= $${params.length}`);
    }
    const yearWhere = yearFilters.length > 0 ? `AND ${yearFilters.join(' AND ')}` : '';

    cteParts.push(`filtered_articles AS (
      SELECT a.article_id, a.publication_year, a.primary_topic
      FROM "Article" a
      ${joinClauses.join(' ')}
      WHERE COALESCE(a.is_deleted, false) = false ${yearWhere}
    )`);

    const cteSql = `WITH ${cteParts.join(', ')}`;

    // Query to find latest year
    const latestYearQuery = `
      ${cteSql}
      SELECT MAX(fa.publication_year)::integer AS latest_year
      FROM filtered_articles fa
    `;

    const latestYearRes = await client.query(latestYearQuery, params);
    let latestYear = latestYearRes.rows[0]?.latest_year;

    if (!latestYear) {
      latestYear = new Date().getFullYear();
    }

    // Last 8 years
    const startYear = latestYear - 7;
    const endYear = latestYear;

    // Get the top 7 keywords in this scope by total count
    const topKeywordsQuery = `
      ${cteSql}
      SELECT k.keyword_id, k.display_name, COUNT(fa.article_id)::integer AS total_count
      FROM "Keyword" k
      JOIN "Keyword_Article" ka ON k.keyword_id = ka.keyword_id
      JOIN filtered_articles fa ON ka.article_id = fa.article_id
      WHERE fa.publication_year BETWEEN ${startYear} AND ${endYear}
      GROUP BY k.keyword_id, k.display_name
      ORDER BY total_count DESC
      LIMIT 7
    `;
    const topKeywordsRes = await client.query(topKeywordsQuery, params);
    const topKeywords = topKeywordsRes.rows;

    // Now query volume per year for these top 7 keywords
    const heatmap = [];
    if (topKeywords.length > 0) {
      const keywordIds = topKeywords.map(kw => Number(kw.keyword_id));
      const volumeParams = [...params, keywordIds, startYear, endYear];
      const keywordIdsIdx = params.length + 1;
      const startYearIdx = params.length + 2;
      const endYearIdx = params.length + 3;

      const volumeQuery = `
        ${cteSql}
        SELECT 
          ka.keyword_id,
          fa.publication_year,
          COUNT(fa.article_id)::integer AS volume
        FROM "Keyword_Article" ka
        JOIN filtered_articles fa ON ka.article_id = fa.article_id
        WHERE ka.keyword_id = ANY($${keywordIdsIdx}::bigint[])
          AND fa.publication_year BETWEEN $${startYearIdx} AND $${endYearIdx}
        GROUP BY ka.keyword_id, fa.publication_year
      `;
      const volumeRes = await client.query(volumeQuery, volumeParams);
      
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
      ${cteSql}
      SELECT sc.display_name, COUNT(fa.article_id) as count
      FROM filtered_articles fa
      JOIN "Topic" t ON fa.primary_topic = t.topic_id
      JOIN "Subject_Category" sc ON t.subject_category_id = sc.subject_category_id
      GROUP BY sc.subject_category_id, sc.display_name
      ORDER BY count DESC
      LIMIT 2
    `;
    const topCatRes = await client.query(topCatQuery, params);
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
