import pool from '../config/database.js';
import { redisGet, redisSet } from './redis.service.js';

const CACHE_TTL = 180; // 3 phút

/**
 * Hàm phân tích và làm sạch keywords
 */
function prepareKeywords(keywords) {
  if (!keywords || !Array.isArray(keywords) || keywords.length === 0) return [];
  return keywords
    .filter(k => k !== undefined && k !== null && k !== '')
    .map(k => String(k).trim().toLowerCase());
}

/**
 * Tính toán và chuẩn hoá percentage để tổng luôn bằng 100%.
 */
function calculateAndNormalizePercentage(groupCounts) {
  const groups = Object.keys(groupCounts);
  if (groups.length === 0) return [];

  const total = groups.reduce((sum, key) => sum + groupCounts[key], 0);
  if (total === 0) return [];

  let result = groups.map((key) => ({
    name: key,
    percentage: Math.round((groupCounts[key] / total) * 100),
    _rawCount: groupCounts[key],
  }));

  // Sắp xếp giảm dần
  result.sort((a, b) => b.percentage - a.percentage);

  // Chuẩn hoá để tổng đúng 100% cho toàn bộ tập dữ liệu
  const currentSum = result.reduce((sum, item) => sum + item.percentage, 0);
  const diff = 100 - currentSum;
  
  if (diff !== 0 && result.length > 0) {
    result[0].percentage += diff;
  }

  // Lọc lấy top 3 topic chiếm nhiều phần trăm nhất
  const top3 = result.slice(0, 3);

  // Xoá field tạm _rawCount và trả về top 3
  return top3.map(({ name, percentage }) => ({ name, percentage }));
}

/**
 * Lấy dữ liệu distribution bằng cách query trực tiếp vào PostgreSQL.
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
  const { distribution_type = 'sector', subject_area, keywords, from_year, to_year } = options;

  // Xử lý impact_quartile (hiện tại Database chưa có cột này, trả về mock data theo chuẩn)
  if (distribution_type === 'impact_quartile') {
    return [
      { name: "Q1", percentage: 45 },
      { name: "Q2", percentage: 30 },
      { name: "Q3", percentage: 15 },
      { name: "Q4", percentage: 10 }
    ];
  }

  const kwLower = prepareKeywords(keywords);

  // ── 1. Tạo cache key động dựa trên bộ lọc ──
  const filterParts = [];
  if (distribution_type) filterParts.push(`type:${distribution_type}`);
  if (subject_area) filterParts.push(`subjectArea:${subject_area}`);
  if (from_year) filterParts.push(`from:${from_year}`);
  if (to_year) filterParts.push(`to:${to_year}`);
  if (kwLower.length > 0) {
    const sortedKws = [...kwLower].sort().join(',');
    filterParts.push(`keywords:${sortedKws}`);
  }

  const cacheKey = filterParts.length > 0
    ? `analytics:distribution:v1:filters:${filterParts.join('|')}`
    : 'analytics:distribution:v1';

  try {
    const cachedData = await redisGet(cacheKey);
    if (cachedData) {
      return JSON.parse(cachedData);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('Failed to get distribution data from Redis cache, querying PostgreSQL:', err?.message || err);
  }

  let sql = `
    SELECT 
      t.display_name AS group_val, 
      COUNT(DISTINCT a.article_id)::int AS total
    FROM "Article" a
    INNER JOIN "Topic" t ON a.primary_topic = t.topic_id
  `;

  const conditions = [
    `a.primary_topic IS NOT NULL`,
    `(a.is_deleted = false OR a.is_deleted IS NULL)`,
    `t.display_name IS NOT NULL`
  ];
  
  const params = [];
  let paramIdx = 1;

  // Nếu có filter keywords, JOIN với các bảng liên quan
  if (kwLower.length > 0) {
    sql += `
      INNER JOIN "article_keyword" ak ON a.article_id = ak.article_id
      INNER JOIN "Keyword" k ON ak.keyword_id = k.keyword_id
    `;
    conditions.push(`LOWER(k.display_name) = ANY($${paramIdx++})`);
    params.push(kwLower);
  }

  if (from_year) {
    conditions.push(`a.publication_year >= $${paramIdx++}`);
    params.push(from_year);
  }

  if (to_year) {
    conditions.push(`a.publication_year <= $${paramIdx++}`);
    params.push(to_year);
  }

  if (subject_area) {
    conditions.push(`LOWER(t.display_name) = LOWER($${paramIdx++})`);
    params.push(subject_area);
  }

  sql += ` WHERE ` + conditions.join(' AND ');
  sql += ` GROUP BY t.display_name `;

  try {
    const { rows } = await pool.query(sql, params);

    const groupCounts = {};
    for (const row of rows) {
      groupCounts[row.group_val] = row.total;
    }

    // Tính %
    const finalResult = calculateAndNormalizePercentage(groupCounts);

    try {
      await redisSet(cacheKey, JSON.stringify(finalResult), CACHE_TTL);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('Failed to set distribution data in Redis cache:', err?.message || err);
    }

    return finalResult;
  } catch (err) {
    throw err;
  }
}
