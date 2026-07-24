import { getCountryCollaborationChord } from '../collaboration/countryCollaboration.service.js';
import { getKeywordVectors } from '../trends/keywordVectors.service.js';
import { fetchWithCache } from '../analytics/cache.service.js';
import pool from '../../config/database.js';

const COLLAB_METRICS_CACHE_PREFIX = 'analytics:collab-metrics:v1';
const COLLAB_METRICS_CACHE_TTL = 43200; // 12 hours

/**
 * Service to generate collaboration insights dynamically.
 * Combines results from Chord (growth rates) and Keyword Vectors to construct the payload.
 * @param {string|number} projectId
 * @param {object} filters
 * @returns {Promise<object>}
 */
export async function getCollaborationInsights(projectId, filters = {}) {
  // 1. Get Country Collaboration Chord to find highest growth pair
  const chordData = await getCountryCollaborationChord({ ...filters, project_id: projectId });
  
  let topPairText = null;
  let topGrowthVal = null;
  
  if (Array.isArray(chordData) && chordData.length > 0) {
    // Find the pair with highest growth
    let maxGrowth = -Infinity;
    let maxPair = null;
    
    chordData.forEach(p => {
      if (p.growth) {
        const val = parseInt(p.growth.replace('%', ''), 10);
        if (!isNaN(val) && val > maxGrowth) {
          maxGrowth = val;
          maxPair = p;
        }
      }
    });
    
    if (maxPair) {
      const formatCountry = (c) => {
        const lower = c.toLowerCase();
        if (lower === 'united states') return 'US';
        if (lower === 'european union') return 'the EU';
        return c.charAt(0).toUpperCase() + lower.slice(1);
      };
      topPairText = `${formatCountry(maxPair.source)} and ${formatCountry(maxPair.target)}`;
      topGrowthVal = maxPair.growth.startsWith('+') ? `${maxPair.growth} YoY` : `+${maxPair.growth} YoY`;
    }
  }

  // 2. Fetch top keywords for Emerging Link and Critical Node
  let emergingKw = '';
  let criticalKw = '';

  try {
    const keywordData = await getKeywordVectors(projectId, { ...filters, limit: 3 });
    if (Array.isArray(keywordData) && keywordData.length > 0) {
      emergingKw = keywordData[0]?.keyword || '';
      if (keywordData.length > 1) {
        criticalKw = keywordData[1]?.keyword || '';
      }
    }
  } catch (err) {
    // Silent fallback
  }

  const description = topPairText && topGrowthVal
    ? `Global research output has shifted significantly towards multi-national clusters, with ${topPairText} showing the highest reciprocal citation growth of ${topGrowthVal}.`
    : 'No international collaboration trends detected for this project during the selected timeframe.';

  return {
    description,
    emergingLink: emergingKw ? `BRICS + ${emergingKw}` : 'No emerging links',
    criticalNode: criticalKw || 'N/A'
  };
}

/**
 * Service to generate collaboration metrics by querying actual data.
 */
export async function getCollaborationMetrics(projectId, filters = {}) {
  const cacheKey = `${COLLAB_METRICS_CACHE_PREFIX}:${projectId || 'all'}:${filters.subject_area || 'all'}:${filters.keywords || 'all'}:${filters.from_year || 'all'}:${filters.to_year || 'all'}`;

  return fetchWithCache(cacheKey, COLLAB_METRICS_CACHE_TTL, async () => {
    const { subject_area, keywords, from_year, to_year } = filters;
    const client = await pool.connect();
    
    try {
      // 1. Resolve Project Scope
      const projectRes = await client.query(
        `SELECT project_id, subject_area FROM "Project" WHERE project_id = $1`,
        [projectId]
      );
      if (projectRes.rows.length === 0) {
        return getEmptyMetrics();
      }
      const projectSubjectAreaId = projectRes.rows[0].subject_area;

      const categoriesRes = await client.query(
        `SELECT subject_category_id FROM "Subject_Category" WHERE subject_area_id = $1 AND COALESCE(is_deleted, false) = false`,
        [projectSubjectAreaId]
      );
      const scopeCategoryIds = categoriesRes.rows.map(r => Number(r.subject_category_id));

      const keywordsRes = await client.query(
        `SELECT keyword_id FROM "Project_Keyword" WHERE project_id = $1`,
        [projectId]
      );
      const scopeKeywordIds = keywordsRes.rows.map(r => Number(r.keyword_id));

      if (scopeCategoryIds.length === 0 && scopeKeywordIds.length === 0) {
        return getEmptyMetrics();
      }

      // 2. Build Article Filter using CTE
      const cteParts = [];
      const params = [];
      
      // Project Scope topics / keywords
      if (scopeCategoryIds.length > 0 || scopeKeywordIds.length > 0) {
        const scopeSelects = [];
        if (scopeCategoryIds.length > 0) {
          params.push(scopeCategoryIds);
          const catIdx = params.length;
          scopeSelects.push(`
            SELECT a.article_id
            FROM "Article" a
            JOIN "Topic" t ON a.primary_topic = t.topic_id
            WHERE t.subject_category_id = ANY($${catIdx}::bigint[]) AND COALESCE(a.is_deleted, false) = false
            UNION
            SELECT st.article_id
            FROM "Sub_Topic" st
            JOIN "Topic" t ON st.topic_id = t.topic_id
            WHERE t.subject_category_id = ANY($${catIdx}::bigint[])
          `);
        }
        if (scopeKeywordIds.length > 0) {
          params.push(scopeKeywordIds);
          const kwIdx = params.length;
          scopeSelects.push(`
            SELECT article_id
            FROM "Keyword_Article"
            WHERE keyword_id = ANY($${kwIdx}::bigint[])
          `);
        }
        cteParts.push(`project_articles AS (${scopeSelects.join(' UNION ')})`);
      }

      // Custom Subject Area Filter
      if (subject_area) {
        const saRes = await client.query(
          `SELECT subject_area_id FROM "Subject_Area" WHERE LOWER(display_name) = LOWER($1) AND COALESCE(is_deleted, false) = false`,
          [subject_area.trim()]
        );

        if (saRes.rows.length > 0) {
          const saId = saRes.rows[0].subject_area_id;
          const scRes = await client.query(
            `SELECT subject_category_id FROM "Subject_Category" WHERE subject_area_id = $1 AND COALESCE(is_deleted, false) = false`,
            [saId]
          );
          const filterCategoryIds = scRes.rows.map(r => Number(r.subject_category_id));

          if (filterCategoryIds.length > 0) {
            params.push(filterCategoryIds);
            const filterCatIdx = params.length;
            cteParts.push(`filter_sa_articles AS (
              SELECT a.article_id
              FROM "Article" a
              JOIN "Topic" t ON a.primary_topic = t.topic_id
              WHERE t.subject_category_id = ANY($${filterCatIdx}::bigint[]) AND COALESCE(a.is_deleted, false) = false
              UNION
              SELECT st.article_id
              FROM "Sub_Topic" st
              JOIN "Topic" t ON st.topic_id = t.topic_id
              WHERE t.subject_category_id = ANY($${filterCatIdx}::bigint[])
            )`);
          }
        }
      }

      // Custom Keyword Filter
      const keywordList = (keywords || '').split(',').map(s => s.trim()).filter(Boolean);
      if (keywordList.length > 0) {
        const kwRes = await client.query(
          `SELECT keyword_id FROM "Keyword" WHERE LOWER(display_name) = ANY($1::text[])`,
          [keywordList.map(s => s.toLowerCase())]
        );
        const filterKeywordIds = kwRes.rows.map(r => Number(r.keyword_id));

        if (filterKeywordIds.length > 0) {
          params.push(filterKeywordIds);
          const filterKwIdx = params.length;
          cteParts.push(`filter_kw_articles AS (
            SELECT article_id
            FROM "Keyword_Article"
            WHERE keyword_id = ANY($${filterKwIdx}::bigint[])
          )`);
        }
      }

      // Year range filters
      const yearFilters = [];
      if (from_year) {
        params.push(Number(from_year));
        yearFilters.push(`a.publication_year >= $${params.length}`);
      }
      if (to_year) {
        params.push(Number(to_year));
        yearFilters.push(`a.publication_year <= $${params.length}`);
      }
      const yearSql = yearFilters.length > 0 ? `AND ${yearFilters.join(' AND ')}` : '';

      // Join them all to form `filtered_articles`
      const joins = [];
      if (scopeCategoryIds.length > 0 || scopeKeywordIds.length > 0) {
        joins.push(`JOIN project_articles pa ON a.article_id = pa.article_id`);
      }
      if (subject_area) {
        joins.push(`JOIN filter_sa_articles fsa ON a.article_id = fsa.article_id`);
      }
      if (keywordList.length > 0) {
        joins.push(`JOIN filter_kw_articles fkw ON a.article_id = fkw.article_id`);
      }

      cteParts.push(`filtered_articles AS (
        SELECT a.article_id, a.publication_year, a.issue_id, a.primary_topic
        FROM "Article" a
        ${joins.join('\n      ')}
        WHERE COALESCE(a.is_deleted, false) = false
          ${yearSql}
      )`);

      const cteSql = `WITH ${cteParts.join(',\n')}`;

      // 3. Execute massive CTE query for metrics
      const query = `
        ${cteSql},
        article_institutions AS (
          SELECT DISTINCT fa.article_id, ia.institution_id, fa.publication_year
          FROM filtered_articles fa
          JOIN "Author_Article" aa ON fa.article_id = aa.article_id
          JOIN "Institution_Author" ia ON aa.author_id = ia.author_id AND ia.year = fa.publication_year
          WHERE ia.institution_id IS NOT NULL
        ),
        collab_edges AS (
          SELECT ai1.institution_id AS source, ai2.institution_id AS target
          FROM article_institutions ai1
          JOIN article_institutions ai2 ON ai1.article_id = ai2.article_id AND ai1.institution_id < ai2.institution_id
        ),
        total_collabs AS (
          SELECT COUNT(DISTINCT (source, target)) AS collab_count
          FROM collab_edges
        ),
        joint_ventures AS (
          SELECT article_id, publication_year
          FROM article_institutions
          GROUP BY article_id, publication_year
          HAVING COUNT(DISTINCT institution_id) > 1
        ),
        joint_ventures_by_year AS (
          SELECT publication_year, COUNT(article_id) AS jv_count
          FROM joint_ventures
          GROUP BY publication_year
        ),
        latest_jv AS (
          SELECT publication_year, jv_count
          FROM joint_ventures_by_year
          ORDER BY publication_year DESC
          LIMIT 1
        ),
        prev_jv AS (
          SELECT jvy.jv_count
          FROM joint_ventures_by_year jvy
          JOIN latest_jv lj ON jvy.publication_year = lj.publication_year - 1
        ),
        cross_over_stats AS (
          SELECT 
            COUNT(fa.article_id) AS total_articles,
            COUNT(CASE WHEN EXISTS (SELECT 1 FROM "Sub_Topic" st WHERE st.article_id = fa.article_id) THEN 1 END) AS crossover_articles
          FROM filtered_articles fa
        ),
        open_access_stats AS (
          SELECT 
            COUNT(DISTINCT fa.article_id) AS total_for_oa,
            COUNT(DISTINCT CASE WHEN j.is_open_access = true THEN fa.article_id END) AS oa_articles
          FROM filtered_articles fa
          JOIN "Issue" iss ON fa.issue_id = iss.issue_id
          JOIN "Volume" v ON iss.volume_id = v.volume_id
          JOIN "Journal" j ON v.journal_id = j.journal_id
        )
        SELECT 
          (SELECT collab_count FROM total_collabs) AS collab_count,
          (SELECT jv_count FROM latest_jv) AS current_jv_count,
          (SELECT jv_count FROM prev_jv) AS prev_jv_count,
          (SELECT crossover_articles FROM cross_over_stats) AS crossover_articles,
          (SELECT total_articles FROM cross_over_stats) AS total_articles,
          (SELECT oa_articles FROM open_access_stats) AS oa_articles,
          (SELECT total_for_oa FROM open_access_stats) AS total_for_oa
      `;

      const res = await client.query(query, params);
      if (res.rows.length === 0) {
        return getEmptyMetrics();
      }
      
      const data = res.rows[0];
      const collabCount = Number(data.collab_count) || 0;
      
      // Calculate YoY Growth
      const currJv = Number(data.current_jv_count) || 0;
      const prevJv = Number(data.prev_jv_count) || 0;
      let avgGrowth = "0.0x";
      if (prevJv > 0) {
        const growthMultiplier = currJv / prevJv;
        avgGrowth = growthMultiplier.toFixed(1) + "x";
      } else if (currJv > 0) {
        avgGrowth = currJv.toFixed(1) + "x"; // Fallback to raw count as multiplier if prev year is 0
      }

      // Calculate Cross-over
      const crossTotal = Number(data.total_articles) || 0;
      const crossCount = Number(data.crossover_articles) || 0;
      const crossOver = crossTotal > 0 ? ((crossCount / crossTotal) * 100).toFixed(1) + "%" : "0.0%";

      // Calculate OA Rate
      const oaTotal = Number(data.total_for_oa) || 0;
      const oaCount = Number(data.oa_articles) || 0;
      const oaRate = oaTotal > 0 ? ((oaCount / oaTotal) * 100).toFixed(0) + "%" : "0%";

      return {
        subtitle: `Aggregate metrics across ${collabCount.toLocaleString()} institutional collaborations.`,
        metrics: [
          {
            value: avgGrowth,
            label: "AVG GROWTH IN JOINT VENTURES"
          },
          {
            value: crossOver,
            label: "INTER-DISCIPLINARY CROSS-OVER"
          },
          {
            value: oaRate,
            label: "OPEN ACCESS RATE"
          }
        ]
      };
    } catch (err) {
      console.error("Error in getCollaborationMetrics:", err);
      return getEmptyMetrics();
    } finally {
      client.release();
    }
  });
}

function getEmptyMetrics() {
  return {
    subtitle: "Aggregate metrics across 0 institutional collaborations.",
    metrics: [
      { value: "0.0x", label: "AVG GROWTH IN JOINT VENTURES" },
      { value: "0.0%", label: "INTER-DISCIPLINARY CROSS-OVER" },
      { value: "0%", label: "OPEN ACCESS RATE" }
    ]
  };
}
