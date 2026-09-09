import pool from '../../../../config/database.js';
import { redisGet, redisSet } from '../../../core/services/infrastructure/redis.service.js';
import logger from '../../../../utils/logger.js';

const CACHE_TTL = 43200; // 12 hours // 3 phút

/**
 * Hàm phân tích và làm sạch keywords
 */
function prepareKeywords(keywords) {
  if (!keywords) return [];
  const list = Array.isArray(keywords) ? keywords : String(keywords).split(',');
  return list.map(k => String(k).trim()).filter(Boolean);
}

/**
 * Tính toán và chuẩn hoá percentage để tổng luôn bằng 100%.
 */
function calculateAndNormalizePercentage(groupCounts, limit = 3) {
  const groups = Object.keys(groupCounts);
  if (groups.length === 0) return [];

  const total = groups.reduce((sum, key) => sum + groupCounts[key], 0);
  if (total === 0) return [];

  let result = groups.map((key) => ({
    name: key,
    percentage: Math.round((groupCounts[key] / total) * 100),
    _rawCount: groupCounts[key]
  }));

  // Sắp xếp giảm dần theo phần trăm (nếu bằng thì xếp theo count thực tế)
  result.sort((a, b) => {
    if (b.percentage === a.percentage) {
      return b._rawCount - a._rawCount;
    }
    return b.percentage - a.percentage;
  });

  // Lọc lấy top 3 topic chiếm nhiều phần trăm nhất
  const topResult = result.slice(0, limit);

  let othersPercentage = 0;
  if (result.length > limit) {
    const remaining = result.slice(limit);
    othersPercentage = remaining.reduce((sum, item) => sum + item.percentage, 0);
  }

  // Xử lý sai số làm tròn để tổng 100%
  const topSum = topResult.reduce((sum, item) => sum + item.percentage, 0);
  const totalSumBeforeFix = topSum + othersPercentage;
  const diff = 100 - totalSumBeforeFix;

  if (diff !== 0) {
    if (othersPercentage > 0 && othersPercentage + diff > 0) {
      othersPercentage += diff; // Đẩy sai số vào Others
    } else if (topResult.length > 0) {
      topResult[0].percentage += diff; // Đẩy vào Top 1 nếu không có Others
    }
  }

  if (othersPercentage > 0) {
    topResult.push({ name: 'Others', percentage: othersPercentage });
  }

  return topResult.map(item => ({ name: item.name, percentage: item.percentage }));
}

/**
 * Lấy dữ liệu distribution bằng cách query trực tiếp vào PostgreSQL.
 * Đã áp dụng logic lọc dựa trên Project Tracking Scope (giống geoDistribution).
 * 
 * @param {Object} options
 * @param {string} options.project_id
 * @param {string} options.distribution_type - 'sector' (mặc định) hoặc 'impact_quartile'
 * @param {string} [options.subject_area]
 * @param {string[]} [options.keywords]
 * @param {number} [options.from_year]
 * @param {number} [options.to_year]
 * @returns {Promise<Array<{name: string, percentage: number}>>}
 */
export async function getDistribution(options) {
  const { project_id, distribution_type = 'sector', subject_area, keywords, from_year, to_year } = options;

  // Xử lý impact_quartile (hiện tại Database chưa có cột này, trả về mock data theo chuẩn)
  if (distribution_type === 'impact_quartile') {
    return [
      { name: "Q1", percentage: 45 },
      { name: "Q2", percentage: 30 },
      { name: "Q3", percentage: 15 },
      { name: "Q4", percentage: 10 }
    ];
  }

  const keywordList = prepareKeywords(keywords);
  const normalizedKeywords = [...keywordList].map(s => s.toLowerCase()).sort().join(',');

  // ── 1. Tạo cache key động dựa trên bộ lọc (Đổi sang v6 để xoá cache cũ ngay lập tức) ──
  const cacheKey = `analytics:distribution:v6:${project_id || 'all'}:${(subject_area || '').toLowerCase()}:${normalizedKeywords}:${from_year || ''}:${to_year || ''}`;

  try {
    const cachedData = await redisGet(cacheKey);
    if (cachedData) {
      return JSON.parse(cachedData);
    }
  } catch (err) {
    logger.warn('Failed to get distribution data from Redis cache:', err?.message || err);
  }

  const client = await pool.connect();

  try {
    // --- FAST PATH: Check if NO custom filters are applied ---
    const hasProjectFilter = project_id && project_id !== 'undefined' && project_id !== 'null';
    const hasSubjectArea = !!subject_area;
    const hasKeywords = keywordList.length > 0;

    if (!hasProjectFilter && !hasSubjectArea && !hasKeywords) {
      let fastParams = [];
      let fastWhere = [];

      if (from_year !== undefined && from_year !== null && from_year !== '') {
        fastParams.push(Number(from_year));
        fastWhere.push(`aty.year >= $${fastParams.length}`);
      }
      if (to_year !== undefined && to_year !== null && to_year !== '') {
        fastParams.push(Number(to_year));
        fastWhere.push(`aty.year <= $${fastParams.length}`);
      }

      const fastWhereClause = fastWhere.length > 0 ? `WHERE ${fastWhere.join(' AND ')}` : '';

      const fastSql = `
        SELECT 
          sa.display_name AS name,
          SUM(aty.article_count)::integer AS count
        FROM "analytics_topic_year" aty
        JOIN "Topic" t ON aty.topic_id = t.topic_id
        JOIN "Subject_Category" sc ON t.subject_category_id = sc.subject_category_id
        JOIN "Subject_Area" sa ON sc.subject_area_id = sa.subject_area_id
        ${fastWhereClause}
        GROUP BY sa.display_name
      `;

      const result = await client.query(fastSql, fastParams);
      
      const counts = {};
      result.rows.forEach(r => {
        counts[r.name] = Number(r.count) || 0;
      });

      const finalResult = calculateAndNormalizePercentage(counts, 3);

      try {
        await redisSet(cacheKey, JSON.stringify(finalResult), CACHE_TTL);
      } catch {}

      return finalResult;
    }
    // --- END FAST PATH ---

    const params = [];
    const sqlFilters = [];

    // --- Xử lý Project Scope (Nếu có project_id hợp lệ) ---
    let useCte = false;
    if (hasProjectFilter) {
      useCte = true;
      const pId = typeof project_id !== 'undefined' ? project_id : (typeof projectId !== 'undefined' ? projectId : null);
      if (pId) {
        params.push(pId);
        if (typeof sqlFilters !== 'undefined') {
          sqlFilters.push(`pas.project_id = $${params.length}`);
        }
      }
    }

    // --- Client custom filter: subject_area (Lọc AND trong phạm vi project) ---
    if (subject_area) {
      const saRes = await client.query(
        `SELECT subject_area_id FROM "Subject_Area" WHERE LOWER(display_name) = LOWER($1) AND COALESCE(is_deleted, false) = false`,
        [subject_area.trim()]
      );

      if (saRes.rows.length === 0) {
        return [];
      }

      const saId = saRes.rows[0].subject_area_id;

      const scRes = await client.query(
        `SELECT subject_category_id FROM "Subject_Category" WHERE subject_area_id = $1 AND COALESCE(is_deleted, false) = false`,
        [saId]
      );
      const filterCategoryIds = scRes.rows.map(r => Number(r.subject_category_id));

      if (filterCategoryIds.length === 0) {
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

    // --- Client custom filter: keywords (Lọc AND trong phạm vi project) ---
    if (keywordList.length > 0) {
      const kwRes = await client.query(
        `SELECT keyword_id FROM "Keyword" WHERE LOWER(display_name) = ANY($1::text[])`,
        [keywordList.map(s => s.toLowerCase())]
      );
      const filterKeywordIds = kwRes.rows.map(r => Number(r.keyword_id));

      if (filterKeywordIds.length === 0) {
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

    // --- Client custom filter: year range ---
    if (from_year !== undefined && from_year !== null) {
      params.push(Number(from_year));
      sqlFilters.push(`a.publication_year >= $${params.length}`);
    }
    if (to_year !== undefined && to_year !== null) {
      params.push(Number(to_year));
      sqlFilters.push(`a.publication_year <= $${params.length}`);
    }

    const whereClause = sqlFilters.length > 0 ? `AND ${sqlFilters.join(' AND ')}` : '';

    const prefix = '';
    const fromTable = typeof useCte !== 'undefined' && useCte ? '"Article" a JOIN "Project_Article_Scope" pas ON a.article_id = pas.article_id' : '"Article" a';

    const querySql = prefix + `
      SELECT 
        t.display_name AS group_val, 
        COUNT(DISTINCT a.article_id)::integer AS total
      FROM ${fromTable}
      INNER JOIN "Topic" t ON a.primary_topic = t.topic_id
      WHERE COALESCE(a.is_deleted, false) = false
        AND t.display_name IS NOT NULL
        ${whereClause}
      GROUP BY t.display_name
    `;

    const result = await client.query(querySql, params);

    const groupCounts = {};
    for (const row of result.rows) {
      groupCounts[row.group_val] = row.total;
    }

    // Tính %
    const finalResult = calculateAndNormalizePercentage(groupCounts);

    try {
      await redisSet(cacheKey, JSON.stringify(finalResult), CACHE_TTL);
    } catch (err) {
      logger.warn('Failed to set distribution data in Redis cache:', err?.message || err);
    }

    return finalResult;
  } finally {
    client.release();
  }
}
