import pool from '../config/database.js';
import logger from '../../utils/logger.js';
import { redisGet, redisSet } from './redis.service.js';

const CACHE_KEY_PREFIX = 'analytics:journal-quartiles:v1';
const CACHE_TTL = 3600; // 1 hour

const QUARTILE_GROUPS = [
  { raw: 'Q1', group: 'Q1 (High Impact)' },
  { raw: 'Q2', group: 'Q2 (Moderate)' },
  { raw: 'Q3', group: 'Q3 (Standard)' },
  { raw: 'Q4', group: 'Q4 (Developing)' },
];

const QUARTILE_ORDER = { Q1: 1, Q2: 2, Q3: 3, Q4: 4 };

/**
 * Parses a comma-separated string of keywords into a clean array.
 * @param {string|undefined} keywords
 * @returns {string[]}
 */
function parseKeywordFilter(keywords) {
  if (!keywords) return [];
  return keywords.split(',').map(k => k.trim()).filter(Boolean);
}

/**
 * Builds the default empty response for quartile distribution.
 * @returns {{totalJournals: number, distribution: Array<{group: string, percentage: number}>}}
 */
function buildEmptyDistribution() {
  return {
    totalJournals: 0,
    distribution: QUARTILE_GROUPS.map(q => ({
      group: q.group,
      percentage: 0,
    })),
  };
}

/**
 * Picks the best quartile for each journal if multiple are present.
 * Best is defined as Q1 > Q2 > Q3 > Q4.
 * @param {Array<{journal_id: number, quartile: string}>} quartileRows
 * @returns {Map<number, string>} A map of journal_id to its best quartile.
 */
function pickBestQuartilePerJournal(quartileRows) {
  const bestQuartileByJournal = new Map();

  for (const row of quartileRows) {
    const currentBest = bestQuartileByJournal.get(row.journal_id);
    if (!currentBest || QUARTILE_ORDER[row.quartile] < QUARTILE_ORDER[currentBest]) {
      bestQuartileByJournal.set(row.journal_id, row.quartile);
    }
  }

  return bestQuartileByJournal;
}

/**
 * Counts journals in each quartile group.
 * @param {Map<number, string>} bestQuartileByJournal
 * @returns {{Q1: number, Q2: number, Q3: number, Q4: number}}
 */
function countQuartileGroups(bestQuartileByJournal) {
  const counts = { Q1: 0, Q2: 0, Q3: 0, Q4: 0 };
  for (const quartile of bestQuartileByJournal.values()) {
    if (counts[quartile] !== undefined) {
      counts[quartile]++;
    }
  }
  return counts;
}

/**
 * Calculates percentages and builds the final response structure.
 * @param {{Q1: number, Q2: number, Q3: number, Q4: number}} counts
 * @returns {{totalJournals: number, distribution: Array<{group: string, percentage: number}>}}
 */
function buildQuartileDistributionResponse(counts) {
  const totalValidJournals = Object.values(counts).reduce((sum, count) => sum + count, 0);

  if (totalValidJournals === 0) {
    return buildEmptyDistribution();
  }

  const distribution = QUARTILE_GROUPS.map(q => ({
    group: q.group,
    percentage: Math.round((counts[q.raw] / totalValidJournals) * 100),
  }));

  // Normalize percentages to ensure the sum is exactly 100 due to rounding
  const totalPercentage = distribution.reduce((sum, item) => sum + item.percentage, 0);
  const diff = 100 - totalPercentage;
  if (diff !== 0 && distribution.length > 0) {
    // Find the item with the largest count to add the difference
    let maxCount = -1;
    let maxIndex = -1;
    QUARTILE_GROUPS.forEach((q, index) => {
      if (counts[q.raw] > maxCount) {
        maxCount = counts[q.raw];
        maxIndex = index;
      }
    });
    if (maxIndex !== -1) {
      distribution[maxIndex].percentage += diff;
    }
  }

  return {
    totalJournals: totalValidJournals,
    distribution,
  };
}

/**
 * Main service function to get journal quartile distribution.
 * @param {object} filters
 * @param {string} filters.projectId
 * @param {string} [filters.subjectArea]
 * @param {string} [filters.keywords]
 * @param {number} [filters.fromYear]
 * @param {number} [filters.toYear]
 * @returns {Promise<{totalJournals: number, distribution: Array<{group: string, percentage: number}>}>}
 */
export async function getJournalQuartileDistribution(filters) {
  const { projectId, subjectArea, keywords, fromYear, toYear } = filters;

  const keywordList = parseKeywordFilter(keywords);
  const normalizedKeywords = [...keywordList].map(s => s.toLowerCase()).sort().join(',');

  const cacheKey = `${CACHE_KEY_PREFIX}:${projectId}:${(subjectArea || '').toLowerCase()}:${normalizedKeywords}:${fromYear || ''}:${toYear || ''}`;

  try {
    const cachedData = await redisGet(cacheKey);
    if (cachedData) {
      logger.info(`[Redis] Cache hit for journal quartiles: ${cacheKey}`);
      return JSON.parse(cachedData);
    }
    logger.info(`[Redis] Cache miss for journal quartiles: ${cacheKey}`);
  } catch (err) {
    logger.warn('Failed to get journal quartiles from Redis, querying database:', err?.message || err);
  }

  const client = await pool.connect();
  try {
    // Step 1: Get Project Scope (reusing logic from forecast.service)
    const projectRes = await client.query(`SELECT subject_area FROM "Project" WHERE project_id = $1`, [projectId]);
    if (projectRes.rows.length === 0) {
      const error = new Error('Project not found');
      error.status = 404;
      throw error;
    }
    const projectSubjectAreaId = projectRes.rows[0].subject_area;

    const categoriesRes = await client.query(`SELECT subject_category_id FROM "Subject_Category" WHERE subject_area_id = $1 AND COALESCE(is_deleted, false) = false`, [projectSubjectAreaId]);
    const scopeCategoryIds = categoriesRes.rows.map(r => Number(r.subject_category_id));

    const keywordsRes = await client.query(`SELECT keyword_id FROM "Project_Keyword" WHERE project_id = $1`, [projectId]);
    const scopeKeywordIds = keywordsRes.rows.map(r => Number(r.keyword_id));

    if (scopeCategoryIds.length === 0 && scopeKeywordIds.length === 0) {
      logger.warn(`Project ${projectId} has no scope. Returning empty quartile distribution.`);
      return buildEmptyDistribution();
    }

    // Step 2: Build query to get filtered journal IDs
    const params = [];
    const articleFilters = [];

    // Project Scope filter
    const scopeConditions = [];
    if (scopeCategoryIds.length > 0) {
      params.push(scopeCategoryIds);
      scopeConditions.push(`(
        EXISTS (SELECT 1 FROM "Topic" t WHERE t.topic_id = a.primary_topic AND t.subject_category_id = ANY($${params.length}::bigint[]))
        OR EXISTS (SELECT 1 FROM "Sub_Topic" st JOIN "Topic" t ON st.topic_id = t.topic_id WHERE st.article_id = a.article_id AND t.subject_category_id = ANY($${params.length}::bigint[]))
      )`);
    }
    if (scopeKeywordIds.length > 0) {
      params.push(scopeKeywordIds);
      scopeConditions.push(`EXISTS (SELECT 1 FROM "Keyword_Article" ka WHERE ka.article_id = a.article_id AND ka.keyword_id = ANY($${params.length}::bigint[]))`);
    }
    articleFilters.push(`(${scopeConditions.join(' OR ')})`);

    // Additional client filters
    if (subjectArea) {
      params.push(subjectArea.trim().toLowerCase());
      articleFilters.push(`EXISTS (
        SELECT 1 FROM "Topic" t
        JOIN "Subject_Category" sc ON t.subject_category_id = sc.subject_category_id
        JOIN "Subject_Area" sa ON sc.subject_area_id = sa.subject_area_id
        WHERE (t.topic_id = a.primary_topic OR EXISTS(SELECT 1 FROM "Sub_Topic" st WHERE st.article_id = a.article_id AND st.topic_id = t.topic_id))
        AND LOWER(sa.display_name) = $${params.length}
      )`);
    }
    if (keywordList.length > 0) {
      params.push(keywordList.map(k => k.toLowerCase()));
      articleFilters.push(`EXISTS (
        SELECT 1 FROM "Keyword_Article" ka JOIN "Keyword" k ON ka.keyword_id = k.keyword_id
        WHERE ka.article_id = a.article_id AND LOWER(k.display_name) = ANY($${params.length}::text[])
      )`);
    }
    if (fromYear) {
      params.push(fromYear);
      articleFilters.push(`a.publication_year >= $${params.length}`);
    }
    if (toYear) {
      params.push(toYear);
      articleFilters.push(`a.publication_year <= $${params.length}`);
    }

    const getJournalsSql = `
      SELECT DISTINCT j.journal_id
      FROM "Article" a
      JOIN "Issue" i ON a.issue_id = i.issue_id
      JOIN "Volume" v ON i.volume_id = v.volume_id
      JOIN "Journal" j ON v.journal_id = j.journal_id
      WHERE COALESCE(a.is_deleted, false) = false
        AND COALESCE(j.is_deleted, false) = false
        AND ${articleFilters.join(' AND ')}
    `;

    const journalResult = await client.query(getJournalsSql, params);
    const journalIds = journalResult.rows.map(r => r.journal_id);

    if (journalIds.length === 0) {
      return buildEmptyDistribution();
    }

    // Step 3: Get latest quartiles for these journals
    const quartileParams = [journalIds];
    const yearFilter = toYear ? `AND jr.year <= $${quartileParams.length + 1}` : '';
    if (toYear) {
      quartileParams.push(toYear);
    }

    const getQuartilesSql = `
      WITH ranked_quartiles AS (
        SELECT
          jr.journal_id,
          jr.value_txt AS quartile,
          ROW_NUMBER() OVER(PARTITION BY jr.journal_id, jr.subject_category_id ORDER BY jr.year DESC) as rn
        FROM "Journal_Ranking" jr
        JOIN "Ranking_Metric" rm ON rm.metric_id = jr.metric_id
        WHERE jr.journal_id = ANY($1::bigint[])
          AND rm.metric_type = 'QUARTILE'
          AND jr.value_txt IN ('Q1', 'Q2', 'Q3', 'Q4')
          ${yearFilter}
      )
      SELECT journal_id, quartile
      FROM ranked_quartiles
      WHERE rn = 1;
    `;

    const quartileResult = await client.query(getQuartilesSql, quartileParams);

    if (quartileResult.rows.length === 0) {
      return buildEmptyDistribution();
    }

    // Step 4: Process data and calculate percentages
    const bestQuartileByJournal = pickBestQuartilePerJournal(quartileResult.rows);
    const counts = countQuartileGroups(bestQuartileByJournal);
    const finalResponse = buildQuartileDistributionResponse(counts);

    // Step 5: Cache and return
    try {
      await redisSet(cacheKey, JSON.stringify(finalResponse), CACHE_TTL);
      logger.info(`[Redis] Journal quartiles cached: ${cacheKey}`);
    } catch (err) {
      logger.warn('Failed to set journal quartiles in Redis cache:', err?.message || err);
    }

    return finalResponse;

  } catch (error) {
    logger.error('Error fetching journal quartile distribution:', error);
    // Re-throw custom status errors for the controller to handle
    if (error.status) {
      throw error;
    }
    // Throw a generic error for other cases
    throw new Error('An internal error occurred while fetching journal quartile distribution.');
  } finally {
    client.release();
  }
}