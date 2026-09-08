import pool from '../../../../config/database.js';
import logger from '../../../../utils/logger.js';
import { redisGet, redisSet } from '../../../core/services/infrastructure/redis.service.js';

// Cache configuration
const CACHE_KEY_PREFIX = 'analytics:geo-distribution';
const CACHE_TTL = 43200; // 12 hours // 5 minutes

/**
 * Validate standard ISO Alpha-2 country code
 * @param {string} code 
 * @returns {boolean}
 */
function isValidCountryCode(code) {
  return typeof code === 'string' && /^[A-Z]{2}$/.test(code);
}

/**
 * Calculate the intensity of research publication density per country based on percentiles.
 * 
 * Rules:
 * - Top 10% -> PEAK (And index 0 is always PEAK to handle small list lengths)
 * - Top 30% -> HIGH
 * - Top 60% -> MEDIUM
 * - Rest -> LOW
 * 
 * @param {Array<object>} countryMetrics 
 * @returns {Array<object>}
 */
function calculateGeoIntensity(countryMetrics) {
  if (!countryMetrics || countryMetrics.length === 0) return [];

  // Sort descending by count just in case
  const sorted = [...countryMetrics].sort((a, b) => b.count - a.count);
  const L = sorted.length;

  return sorted.map((item, i) => {
    const percentile = i / L;
    let intensity = 'LOW';

    if (percentile < 0.1 || i === 0) {
      intensity = 'PEAK';
    } else if (percentile < 0.3) {
      intensity = 'HIGH';
    } else if (percentile < 0.6) {
      intensity = 'MEDIUM';
    }

    return {
      ...item,
      intensity,
      count: Number(item.count || 0)
    };
  });
}

/**
 * Main service to get geographical distribution analytics for a project with optional filters.
 * 
 * @param {string|number} projectId - ID of the project.
 * @param {object} filters - Additional query filters.
 * @param {string} [filters.country] - Optional country filter. If provided, returns distribution by region within that country.
 * @param {string} [filters.subjectArea] - Optional subject area filter.
 * @param {string|string[]} [filters.keywords] - Optional keywords list.
 * @param {number} [filters.fromYear] - Optional start year.
 * @param {number} [filters.toYear] - Optional end year.
 * @returns {Promise<Array<object>>}
 */
export async function getGeoDistribution(projectId, filters = {}) {
  const { country, subjectArea, keywords, fromYear, toYear } = filters;
  const normalizedCountry = country ? String(country).trim() : '';

  // Process keywords into a clean sorted string to form a stable cache key
  let normalizedKeywords = '';
  let keywordList = [];
  if (keywords) {
    keywordList = Array.isArray(keywords)
      ? keywords
      : String(keywords).split(',').map(s => s.trim()).filter(Boolean);
    normalizedKeywords = [...keywordList].map(s => s.toLowerCase()).sort().join(',');
  }

  // Build stable cache key. Keep the old key shape when country is not provided.
  const cacheKey = normalizedCountry
    ? `${CACHE_KEY_PREFIX}:${projectId}:country:${normalizedCountry.toLowerCase()}:${(subjectArea || '').toLowerCase()}:${normalizedKeywords}:${fromYear || ''}:${toYear || ''}`
    : `${CACHE_KEY_PREFIX}:${projectId}:${(subjectArea || '').toLowerCase()}:${normalizedKeywords}:${fromYear || ''}:${toYear || ''}`;

  try {
    const cachedData = await redisGet(cacheKey);
    if (cachedData) {
      logger.info(`[Redis] Geo-distribution cache hit for key: ${cacheKey}`);
      return JSON.parse(cachedData);
    }
  } catch (err) {
    logger.warn('Failed to get geo-distribution from Redis, fallback to DB:', err?.message || err);
  }

  const client = await pool.connect();

  try {
    // --- FAST PATH: Check if NO custom filters are applied ---
    const hasProjectFilter = projectId && projectId !== 'undefined' && projectId !== 'null';
    const hasSubjectArea = !!subjectArea;
    const hasKeywords = keywordList.length > 0;
    const hasCountry = !!normalizedCountry;

    if (!hasProjectFilter && !hasSubjectArea && !hasKeywords) {
      let fastParams = [];
      let fastWhere = [];

      if (fromYear !== undefined && fromYear !== null && fromYear !== '') {
        fastParams.push(Number(fromYear));
        fastWhere.push(`year >= $${fastParams.length}`);
      }
      if (toYear !== undefined && toYear !== null && toYear !== '') {
        fastParams.push(Number(toYear));
        fastWhere.push(`year <= $${fastParams.length}`);
      }

      const fastWhereClause = fastWhere.length > 0 ? `WHERE ${fastWhere.join(' AND ')}` : '';
      let fastSql;

      if (hasCountry) {
        // Find regions inside this country is harder with precomputed country codes
        // We'll fallback to standard DB queries if country filter is present.
      } else {
        fastSql = `
          SELECT 
            country_code AS "countryCode",
            SUM(article_count)::integer AS count
          FROM "analytics_country_year"
          ${fastWhereClause}
          GROUP BY country_code
          ORDER BY count DESC
        `;
        
        const result = await client.query(fastSql, fastParams);
        
        const validRecords = [];
        for (const row of result.rows) {
          const code = row.countryCode ? String(row.countryCode).toUpperCase().trim() : null;
          if (!code || !isValidCountryCode(code)) continue;
          validRecords.push({ countryCode: code, count: Number(row.count || 0) });
        }

        const finalizedData = calculateGeoIntensity(validRecords);

        try {
          await redisSet(cacheKey, JSON.stringify(finalizedData), CACHE_TTL);
        } catch (cacheErr) {}

        return finalizedData;
      }
    }
    // --- END FAST PATH ---

    const params = [];
    const sqlFilters = [];

    let useCte = false;
    if (hasProjectFilter) {
      useCte = true;
      const pId = typeof projectId !== 'undefined' ? projectId : null;
      if (pId) {
        params.push(pId);
        sqlFilters.push(`pas.project_id = $${params.length}`);
      }
    }

    // Client custom filter: subject_area
    if (subjectArea) {
      // Find subject_area_id by display_name
      const saRes = await client.query(
        `SELECT subject_area_id FROM "Subject_Area" WHERE LOWER(display_name) = LOWER($1) AND COALESCE(is_deleted, false) = false`,
        [subjectArea.trim()]
      );

      if (saRes.rows.length === 0) {
        logger.info(`Subject area filter '${subjectArea}' not found. Returning empty array.`);
        return [];
      }

      const saId = saRes.rows[0].subject_area_id;

      // Get categories under this subject_area
      const scRes = await client.query(
        `SELECT subject_category_id FROM "Subject_Category" WHERE subject_area_id = $1 AND COALESCE(is_deleted, false) = false`,
        [saId]
      );
      const filterCategoryIds = scRes.rows.map(r => Number(r.subject_category_id));

      if (filterCategoryIds.length === 0) {
        logger.info(`Subject area filter '${subjectArea}' has no categories. Returning empty array.`);
        return [];
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

    // Client custom filter: keywords
    if (keywordList.length > 0) {
      const kwRes = await client.query(
        `SELECT keyword_id FROM "Keyword" WHERE LOWER(display_name) = ANY($1::text[])`,
        [keywordList.map(s => s.toLowerCase())]
      );
      const filterKeywordIds = kwRes.rows.map(r => Number(r.keyword_id));

      if (filterKeywordIds.length === 0) {
        logger.info(`None of the keywords in filter matched. Returning empty array.`);
        return [];
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

    // Client custom filter: year range
    if (fromYear !== undefined && fromYear !== null && fromYear !== '') {
      params.push(Number(fromYear));
      sqlFilters.push(`a.publication_year >= $${params.length}`);
    }
    if (toYear !== undefined && toYear !== null && toYear !== '') {
      params.push(Number(toYear));
      sqlFilters.push(`a.publication_year <= $${params.length}`);
    }

    const whereClause = sqlFilters.length > 0 ? `AND ${sqlFilters.join(' AND ')}` : '';

    let querySql;

    if (normalizedCountry) {
      params.push(normalizedCountry);
      const countryIndex = params.length;

      querySql = `
        WITH FilteredArticles AS (
            SELECT a.article_id, a.issue_id
            FROM "Article" a
            ${useCte ? 'JOIN "Project_Article_Scope" pas ON a.article_id = pas.article_id' : ''}
            WHERE COALESCE(a.is_deleted, false) = false
              ${whereClause}
          )
        SELECT 
          country_zone.code AS "countryCode",
          country_zone.name AS "countryName",
          region_zone.code AS "regionCode",
          region_zone.name AS "regionName",
          COUNT(DISTINCT fa.article_id)::integer AS count
        FROM FilteredArticles fa
        JOIN "Issue" i ON fa.issue_id = i.issue_id AND COALESCE(i.is_deleted, false) = false
        JOIN "Volume" v ON i.volume_id = v.volume_id AND COALESCE(v.is_deleted, false) = false
        JOIN "Journal" j ON v.journal_id = j.journal_id AND COALESCE(j.is_deleted, false) = false
        JOIN "Zone" country_zone ON j.country = country_zone.zone_id AND country_zone.type = 'COUNTRY'
        JOIN "Zone" region_zone ON j.region = region_zone.zone_id AND region_zone.type = 'REGION'
        WHERE (
            country_zone.zone_id::text = $${countryIndex}
            OR LOWER(country_zone.name) = LOWER($${countryIndex})
            OR UPPER(country_zone.code) = UPPER($${countryIndex})
            OR UPPER(country_zone.iso_code) = UPPER($${countryIndex})
          )
        GROUP BY country_zone.code, country_zone.name, region_zone.code, region_zone.name
        ORDER BY count DESC
      `;
    } else {
      querySql = `
        WITH FilteredArticles AS (
            SELECT a.article_id, a.issue_id
            FROM "Article" a
            ${useCte ? 'JOIN "Project_Article_Scope" pas ON a.article_id = pas.article_id' : ''}
            WHERE COALESCE(a.is_deleted, false) = false
              ${whereClause}
          )
        SELECT 
          z.code AS "countryCode",
          COUNT(DISTINCT fa.article_id)::integer AS count
        FROM FilteredArticles fa
        JOIN "Issue" i ON fa.issue_id = i.issue_id AND COALESCE(i.is_deleted, false) = false
        JOIN "Volume" v ON i.volume_id = v.volume_id AND COALESCE(v.is_deleted, false) = false
        JOIN "Journal" j ON v.journal_id = j.journal_id AND COALESCE(j.is_deleted, false) = false
        JOIN "Zone" z ON j.country = z.zone_id AND z.type = 'COUNTRY'
        GROUP BY z.code
        ORDER BY count DESC
      `;
    }

    const result = await client.query(querySql, params);

    // Filter and clean location records
    const validRecords = [];
    for (const row of result.rows) {
      if (normalizedCountry) {
        const regionCode = row.regionCode ? String(row.regionCode).toUpperCase().trim() : null;
        const regionName = row.regionName ? String(row.regionName).trim() : null;

        if (!regionCode && !regionName) {
          logger.warn(`Skipping invalid region for country filter '${normalizedCountry}'`);
          continue;
        }

        validRecords.push({
          countryCode: row.countryCode ? String(row.countryCode).toUpperCase().trim() : null,
          countryName: row.countryName ? String(row.countryName).trim() : null,
          regionCode,
          regionName,
          count: Number(row.count || 0)
        });
      } else {
        const code = row.countryCode ? String(row.countryCode).toUpperCase().trim() : null;
        if (!code || !isValidCountryCode(code)) {
          logger.warn(`Skipping invalid countryCode: '${row.countryCode}'`);
          continue;
        }
        validRecords.push({
          countryCode: code,
          count: Number(row.count || 0)
        });
      }
    }

    // Calculate dynamic intensity
    const finalizedData = calculateGeoIntensity(validRecords);

    // Save to Redis cache
    try {
      await redisSet(cacheKey, JSON.stringify(finalizedData), CACHE_TTL);
      logger.info(`[Redis] Geo-distribution results cached for key: ${cacheKey}`);
    } catch (cacheErr) {
      logger.warn('Failed to save geo-distribution to Redis:', cacheErr?.message || cacheErr);
    }

    return finalizedData;

  } finally {
    client.release();
  }
}
