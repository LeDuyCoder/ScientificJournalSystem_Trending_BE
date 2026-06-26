import pool from '../config/database.js';
import logger from '../../utils/logger.js';
import { redisGet, redisSet } from './redis.service.js';

const FORECAST_TYPES = {
  PEAK: 'PEAK',
  ALERT: 'ALERT',
  SYNERGY: 'SYNERGY'
};

// Cache settings
const CACHE_KEY_PREFIX = 'analytics:forecast:project';
const CACHE_TTL = 3600; // Cache for 1 hour

function roundNumber(value, digits = 1) {
  if (!Number.isFinite(value)) return 0;

  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function safeDivide(numerator, denominator) {
  if (!denominator || denominator === 0) return 0;
  return numerator / denominator;
}

function percentageChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return 0;

  if (previous === 0) {
    return current > 0 ? 100 : 0;
  }

  return roundNumber(((current - previous) / previous) * 100, 1);
}

function average(values) {
  const validValues = values.filter(Number.isFinite);

  if (validValues.length === 0) return 0;

  const total = validValues.reduce((sum, value) => sum + value, 0);
  return roundNumber(total / validValues.length, 1);
}

function fillMissingYears(yearlyRows) {
  const cleanedRows = yearlyRows
    .map((row) => ({
      year: Number(row.year),
      article_count: Number(row.article_count || 0),
      citation_count: Number(row.citation_count || 0)
    }))
    .filter((row) => Number.isFinite(row.year));

  if (cleanedRows.length === 0) return [];

  const minYear = Math.min(...cleanedRows.map((row) => row.year));
  const maxYear = Math.max(...cleanedRows.map((row) => row.year));

  const byYear = new Map();

  for (const row of cleanedRows) {
    const current = byYear.get(row.year) || {
      year: row.year,
      article_count: 0,
      citation_count: 0
    };

    current.article_count += row.article_count;
    current.citation_count += row.citation_count;

    byYear.set(row.year, current);
  }

  const normalized = [];

  for (let year = minYear; year <= maxYear; year += 1) {
    normalized.push(
      byYear.get(year) || {
        year,
        article_count: 0,
        citation_count: 0
      }
    );
  }

  return normalized;
}

function getGrowthRates(yearlyMetrics) {
  const growthRates = [];

  for (let i = 1; i < yearlyMetrics.length; i += 1) {
    const previous = yearlyMetrics[i - 1];
    const current = yearlyMetrics[i];

    growthRates.push(
      percentageChange(current.article_count, previous.article_count)
    );
  }

  return growthRates;
}

/**
 * Article không có subject_category_id trực tiếp.
 * Nên cần check qua:
 * Article.primary_topic -> Topic.subject_category_id
 * hoặc Sub_Topic -> Topic.subject_category_id
 */
function buildSubjectScopeSql(paramIndex) {
  return `
    (
      EXISTS (
        SELECT 1
        FROM "Topic" primary_topic
        WHERE primary_topic.topic_id = a.primary_topic
          AND primary_topic.subject_category_id = ANY($${paramIndex}::bigint[])
      )
      OR EXISTS (
        SELECT 1
        FROM "Sub_Topic" st
        JOIN "Topic" sub_topic
          ON st.topic_id = sub_topic.topic_id
        WHERE st.article_id = a.article_id
          AND sub_topic.subject_category_id = ANY($${paramIndex}::bigint[])
      )
    )
  `;
}

function buildKeywordScopeSql(paramIndex) {
  return `
    EXISTS (
      SELECT 1
      FROM "Keyword_Article" ka
      WHERE ka.article_id = a.article_id
        AND ka.keyword_id = ANY($${paramIndex}::bigint[])
    )
  `;
}

export async function getProjectScope(client, projectId) {
  const projectRes = await client.query(
    `
    SELECT 
      p.project_id,
      sa.subject_area_id,
      sa.display_name AS subject_area_name
    FROM "Project" p
    JOIN "Subject_Area" sa
      ON p.subject_area = sa.subject_area_id
    WHERE p.project_id = $1
      AND COALESCE(sa.is_deleted, false) = false
    `,
    [projectId]
  );

  if (projectRes.rows.length === 0) {
    const err = new Error('Project not found or has no associated subject area');
    err.code = 404;
    throw err;
  }

  const project = projectRes.rows[0];

  const categoriesRes = await client.query(
    `
    SELECT subject_category_id
    FROM "Subject_Category"
    WHERE subject_area_id = $1
      AND COALESCE(is_deleted, false) = false
    `,
    [project.subject_area_id]
  );

  const keywordsRes = await client.query(
    `
    SELECT 
      k.keyword_id,
      k.display_name
    FROM "Project_Keyword" pk
    JOIN "Keyword" k
      ON pk.keyword_id = k.keyword_id
    WHERE pk.project_id = $1
    `,
    [projectId]
  );

  return {
    projectId: project.project_id,
    subjectAreaId: Number(project.subject_area_id),
    subjectAreaName: project.subject_area_name,
    subjectCategoryIds: categoriesRes.rows.map((row) =>
      Number(row.subject_category_id)
    ),
    keywordIds: keywordsRes.rows.map((row) => Number(row.keyword_id)),
    keywordNames: keywordsRes.rows.map((row) => row.display_name)
  };
}

async function fetchYearlyArticleMetrics(client, scope) {
  const params = [];
  const filters = [];

  if (scope.subjectCategoryIds.length > 0) {
    params.push(scope.subjectCategoryIds);
    filters.push(buildSubjectScopeSql(params.length));
  }

  if (scope.keywordIds.length > 0) {
    params.push(scope.keywordIds);
    filters.push(buildKeywordScopeSql(params.length));
  }

  const scopeFilter = filters.length > 0 ? `(${filters.join(' OR ')})` : 'FALSE';

  const metricsRes = await client.query(
    `
    SELECT
      a.publication_year AS year,
      COUNT(DISTINCT a.article_id) AS article_count,
      COALESCE(SUM(COALESCE(a.citation_count, 0)), 0) AS citation_count
    FROM "Article" a
    WHERE ${scopeFilter}
      AND a.publication_year IS NOT NULL
      AND COALESCE(a.is_deleted, false) = false
    GROUP BY a.publication_year
    ORDER BY a.publication_year ASC
    `,
    params
  );

  return fillMissingYears(metricsRes.rows);
}

async function fetchKeywordYearlyMetrics(client, scope) {
  if (scope.keywordIds.length === 0) return [];

  const params = [scope.keywordIds];
  const filters = [
    'ka.keyword_id = ANY($1::bigint[])',
    'a.publication_year IS NOT NULL',
    'COALESCE(a.is_deleted, false) = false'
  ];

  if (scope.subjectCategoryIds.length > 0) {
    params.push(scope.subjectCategoryIds);
    filters.push(buildSubjectScopeSql(params.length));
  }

  const keywordMetricsRes = await client.query(
    `
    SELECT
      k.keyword_id,
      k.display_name AS keyword_name,
      a.publication_year AS year,
      COUNT(DISTINCT a.article_id) AS article_count,
      COALESCE(SUM(COALESCE(a.citation_count, 0)), 0) AS citation_count
    FROM "Keyword_Article" ka
    JOIN "Keyword" k
      ON ka.keyword_id = k.keyword_id
    JOIN "Article" a
      ON ka.article_id = a.article_id
    WHERE ${filters.join(' AND ')}
    GROUP BY
      k.keyword_id,
      k.display_name,
      a.publication_year
    ORDER BY
      k.display_name ASC,
      a.publication_year ASC
    `,
    params
  );

  return keywordMetricsRes.rows.map((row) => ({
    keyword_id: Number(row.keyword_id),
    keyword_name: row.keyword_name,
    year: Number(row.year),
    article_count: Number(row.article_count || 0),
    citation_count: Number(row.citation_count || 0)
  }));
}

async function fetchCrossDomainMetrics(client, scope) {
  if (scope.keywordIds.length === 0) return [];

  const crossDomainRes = await client.query(
    `
    WITH article_subjects AS (
      SELECT DISTINCT
        a.article_id,
        sa.subject_area_id,
        sa.display_name AS subject_area_name
      FROM "Article" a
      JOIN "Topic" t
        ON a.primary_topic = t.topic_id
      JOIN "Subject_Category" sc
        ON t.subject_category_id = sc.subject_category_id
      JOIN "Subject_Area" sa
        ON sc.subject_area_id = sa.subject_area_id
      WHERE COALESCE(a.is_deleted, false) = false
        AND COALESCE(t.is_deleted, false) = false
        AND COALESCE(sc.is_deleted, false) = false
        AND COALESCE(sa.is_deleted, false) = false

      UNION

      SELECT DISTINCT
        a.article_id,
        sa.subject_area_id,
        sa.display_name AS subject_area_name
      FROM "Article" a
      JOIN "Sub_Topic" st
        ON a.article_id = st.article_id
      JOIN "Topic" t
        ON st.topic_id = t.topic_id
      JOIN "Subject_Category" sc
        ON t.subject_category_id = sc.subject_category_id
      JOIN "Subject_Area" sa
        ON sc.subject_area_id = sa.subject_area_id
      WHERE COALESCE(a.is_deleted, false) = false
        AND COALESCE(t.is_deleted, false) = false
        AND COALESCE(sc.is_deleted, false) = false
        AND COALESCE(sa.is_deleted, false) = false
    )
    SELECT
      article_subjects.subject_area_name AS related_subject_area,
      k.display_name AS keyword_name,
      COUNT(DISTINCT a.article_id) AS article_count,
      COALESCE(SUM(COALESCE(a.citation_count, 0)), 0) AS citation_count
    FROM "Keyword_Article" ka
    JOIN "Keyword" k
      ON ka.keyword_id = k.keyword_id
    JOIN "Article" a
      ON ka.article_id = a.article_id
    JOIN article_subjects
      ON article_subjects.article_id = a.article_id
    WHERE ka.keyword_id = ANY($1::bigint[])
      AND article_subjects.subject_area_id <> $2
      AND COALESCE(a.is_deleted, false) = false
    GROUP BY
      article_subjects.subject_area_name,
      k.display_name
    ORDER BY
      article_count DESC,
      citation_count DESC
    LIMIT 1
    `,
    [scope.keywordIds, scope.subjectAreaId]
  );

  return crossDomainRes.rows.map((row) => ({
    related_subject_area: row.related_subject_area,
    keyword_name: row.keyword_name,
    article_count: Number(row.article_count || 0),
    citation_count: Number(row.citation_count || 0)
  }));
}

function analyzePeak(scope, yearlyMetrics) {
  const subject = scope.subjectAreaName || 'the relevant research area';

  if (yearlyMetrics.length === 0) {
    return {
      type: FORECAST_TYPES.PEAK,
      title_key: 'forecast.peak.title',
      insight_key: 'forecast.peak.insufficient_data',
      parameters: {
        subject,
        signal: 'insufficient_data',
        latestYear: null,
        articleCount: 0,
        citationCount: 0,
        growthRate: 0,
        averageGrowthRate: 0,
        citationGrowthRate: 0
      }
    };
  }

  const latest = yearlyMetrics[yearlyMetrics.length - 1];
  const previous = yearlyMetrics[yearlyMetrics.length - 2] || null;

  const growthRates = getGrowthRates(yearlyMetrics);
  const recentGrowthRates = growthRates.slice(-3);

  const growthRate = previous
    ? percentageChange(latest.article_count, previous.article_count)
    : 0;

  const citationGrowthRate = previous
    ? percentageChange(latest.citation_count, previous.citation_count)
    : 0;

  const averageGrowthRate = average(recentGrowthRates);

  const isPeakSignal =
    latest.article_count > 0 &&
    (growthRate >= 25 || averageGrowthRate >= 20 || citationGrowthRate >= 30);

  return {
    type: FORECAST_TYPES.PEAK,
    title_key: 'forecast.peak.title',
    insight_key: isPeakSignal
      ? 'forecast.peak.insight'
      : 'forecast.peak.no_strong_signal',
    parameters: {
      subject,
      signal: isPeakSignal ? 'emerging_peak' : 'no_strong_peak_signal',
      latestYear: latest.year,
      articleCount: latest.article_count,
      citationCount: latest.citation_count,
      growthRate,
      averageGrowthRate,
      citationGrowthRate
    }
  };
}

function analyzeAlert(scope, yearlyMetrics) {
  const subject = scope.subjectAreaName || 'the relevant research area';

  if (yearlyMetrics.length === 0) {
    return {
      type: FORECAST_TYPES.ALERT,
      title_key: 'forecast.alert.title',
      insight_key: 'forecast.alert.insufficient_data',
      parameters: {
        subject,
        signal: 'insufficient_data',
        latestYear: null,
        articleCount: 0,
        citationPerArticle: 0,
        citationPerArticleChange: 0,
        latestGrowthRate: 0,
        previousGrowthRate: 0,
        growthSlowdown: 0
      }
    };
  }

  const latest = yearlyMetrics[yearlyMetrics.length - 1];
  const previous = yearlyMetrics[yearlyMetrics.length - 2] || null;
  const beforePrevious = yearlyMetrics[yearlyMetrics.length - 3] || null;

  const latestGrowthRate = previous
    ? percentageChange(latest.article_count, previous.article_count)
    : 0;

  const previousGrowthRate =
    previous && beforePrevious
      ? percentageChange(previous.article_count, beforePrevious.article_count)
      : 0;

  const growthSlowdown = roundNumber(latestGrowthRate - previousGrowthRate, 1);

  const latestCitationPerArticle = roundNumber(
    safeDivide(latest.citation_count, latest.article_count),
    2
  );

  const previousCitationPerArticle = previous
    ? roundNumber(safeDivide(previous.citation_count, previous.article_count), 2)
    : 0;

  const citationPerArticleChange = previous
    ? percentageChange(latestCitationPerArticle, previousCitationPerArticle)
    : 0;

  const isSaturationAlert =
    latest.article_count > 0 &&
    (
      citationPerArticleChange <= -15 ||
      growthSlowdown <= -20 ||
      (previousGrowthRate >= 20 && latestGrowthRate <= 5)
    );

  return {
    type: FORECAST_TYPES.ALERT,
    title_key: 'forecast.alert.title',
    insight_key: isSaturationAlert
      ? 'forecast.alert.insight'
      : 'forecast.alert.no_saturation_signal',
    parameters: {
      subject,
      signal: isSaturationAlert ? 'saturation_risk' : 'no_saturation_signal',
      latestYear: latest.year,
      articleCount: latest.article_count,
      citationPerArticle: latestCitationPerArticle,
      citationPerArticleChange,
      latestGrowthRate,
      previousGrowthRate,
      growthSlowdown
    }
  };
}

function getTopKeywordSummary(keywordYearlyMetrics) {
  const byKeyword = new Map();

  for (const row of keywordYearlyMetrics) {
    const current = byKeyword.get(row.keyword_id) || {
      keyword_id: row.keyword_id,
      keyword_name: row.keyword_name,
      article_count: 0,
      citation_count: 0
    };

    current.article_count += row.article_count;
    current.citation_count += row.citation_count;

    byKeyword.set(row.keyword_id, current);
  }

  return [...byKeyword.values()].sort((a, b) => {
    if (b.article_count !== a.article_count) {
      return b.article_count - a.article_count;
    }

    return b.citation_count - a.citation_count;
  })[0] || null;
}

function analyzeSynergy(scope, keywordYearlyMetrics, crossDomainMetrics) {
  const subject = scope.subjectAreaName || 'the relevant research area';
  const topCrossDomain = crossDomainMetrics[0] || null;
  const topKeyword = getTopKeywordSummary(keywordYearlyMetrics);

  if (topCrossDomain) {
    return {
      type: FORECAST_TYPES.SYNERGY,
      title_key: 'forecast.synergy.title',
      insight_key: 'forecast.synergy.insight',
      parameters: {
        subject,
        keyword: topCrossDomain.keyword_name,
        relatedSubject: topCrossDomain.related_subject_area,
        signal: 'cross_domain_synergy',
        articleCount: topCrossDomain.article_count,
        citationCount: topCrossDomain.citation_count
      }
    };
  }

  return {
    type: FORECAST_TYPES.SYNERGY,
    title_key: 'forecast.synergy.title',
    insight_key: topKeyword
      ? 'forecast.synergy.keyword_only'
      : 'forecast.synergy.insufficient_data',
    parameters: {
      subject,
      keyword: topKeyword?.keyword_name || scope.keywordNames[0] || 'related topics',
      relatedSubject: null,
      signal: topKeyword ? 'keyword_activity_detected' : 'insufficient_data',
      articleCount: topKeyword?.article_count || 0,
      citationCount: topKeyword?.citation_count || 0
    }
  };
}

/**
 * Fetch forecast insights for a given project.
 *
 * Flow:
 * 1. Get project subject area + keywords.
 * 2. Resolve subject categories from subject area.
 * 3. Fetch yearly article metrics.
 * 4. Analyze PEAK, ALERT, SYNERGY.
 *
 * @param {number|string} projectId
 * @returns {Promise<Array<object>>}
 */
export async function getForecastInsights(projectId) {
  // 1. Build cache key and check Redis first
  const cacheKey = `${CACHE_KEY_PREFIX}:${projectId}`;
  try {
    const cachedData = await redisGet(cacheKey);
    if (cachedData) {
      logger.info(`[Redis] Forecast cache hit for project ${projectId}`);
      return JSON.parse(cachedData);
    }
    logger.info(`[Redis] Forecast cache miss for project ${projectId}`);
  } catch (err) {
    logger.warn('Failed to get forecast from Redis, querying database:', err?.message || err);
  }

  const client = await pool.connect();

  try {
    const scope = await getProjectScope(client, projectId);


    logger.info(
      `Analysis scope for project ${projectId}: Area='${scope.subjectAreaName}', Keywords='${scope.keywordNames.join(', ')}'`
    );

    if (scope.subjectCategoryIds.length === 0 && scope.keywordIds.length === 0) {
      logger.warn(
        `Project ${projectId} has no subject categories and no keywords. Returning limited analysis signals.`
      );
    }

    const yearlyMetrics = await fetchYearlyArticleMetrics(client, scope);
    const keywordYearlyMetrics = await fetchKeywordYearlyMetrics(client, scope);
    const crossDomainMetrics = await fetchCrossDomainMetrics(client, scope);

    const results = [
      analyzePeak(scope, yearlyMetrics),
      analyzeAlert(scope, yearlyMetrics),
      analyzeSynergy(scope, keywordYearlyMetrics, crossDomainMetrics)
    ];

    // 2. Save result to Redis cache before returning
    try {
      await redisSet(cacheKey, JSON.stringify(results), CACHE_TTL);
      logger.info(`[Redis] Forecast cached for project ${projectId}`);
    } catch (err) {
      logger.warn('Failed to set forecast in Redis cache:', err?.message || err);
    }

    return results;
  } catch (error) {
    if (error.code === 404) {
      throw error;
    }

    logger.error(`Error fetching forecast for project ${projectId}:`, error);
    throw error;
  } finally {
    client.release();
  }
}