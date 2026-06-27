import pool from '../config/database.js';
import { redisGet, redisSet } from './redis.service.js';
import logger from '../../utils/logger.js';

const CACHE_TTL = 180; // 3 phút

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
    const params = [];
    const sqlFilters = [];

    // --- Xử lý Project Scope (Nếu có project_id hợp lệ) ---
    if (project_id && project_id !== 'undefined' && project_id !== 'null') {
      // 1. Verify project
      const projectRes = await client.query(
        `SELECT project_id, subject_area FROM "Project" WHERE project_id = $1`,
        [project_id]
      );

      if (projectRes.rows.length === 0) {
        const error = new Error('Project not found');
        error.status = 404;
        throw error;
      }

      const project = projectRes.rows[0];

      // 2. Fetch project's categories (Tracking Scope)
      const categoriesRes = await client.query(
        `SELECT subject_category_id FROM "Subject_Category" WHERE subject_area_id = $1 AND COALESCE(is_deleted, false) = false`,
        [project.subject_area]
      );
      const projectCategoryIds = categoriesRes.rows.map(r => Number(r.subject_category_id));

      // 3. Fetch project's keywords (Tracking Scope)
      const keywordsRes = await client.query(
        `SELECT keyword_id FROM "Project_Keyword" WHERE project_id = $1`,
        [project_id]
      );
      const projectKeywordIds = keywordsRes.rows.map(r => Number(r.keyword_id));

      if (projectCategoryIds.length === 0 && projectKeywordIds.length === 0) {
        return [];
      }

      // --- Xác định cấu trúc của Project Scope dựa vào Frontend truyền gì ---
      let applyProjectCategories = false;
      let applyProjectKeywords = false;

      if (subject_area && !keywordList.length) {
        applyProjectCategories = true;
      } else if (keywordList.length > 0 && !subject_area) {
        applyProjectKeywords = true;
      } else {
        applyProjectCategories = true;
        applyProjectKeywords = true;
      }

      const scopeConditions = [];

      if (applyProjectCategories && projectCategoryIds.length > 0) {
        params.push(projectCategoryIds);
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

      if (applyProjectKeywords && projectKeywordIds.length > 0) {
        params.push(projectKeywordIds);
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
      } else {
        return [];
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

    const querySql = `
      SELECT 
        t.display_name AS group_val, 
        COUNT(DISTINCT a.article_id)::integer AS total
      FROM "Article" a
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
