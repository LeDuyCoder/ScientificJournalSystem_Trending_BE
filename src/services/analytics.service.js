import pool from '../config/database.js';
import logger from '../../utils/logger.js';
import { getProjectScope } from './forecast.service.js'; // Tái sử dụng hàm lấy scope
import { redisGet, redisSet } from './redis.service.js';

// Cache settings
const CACHE_KEY_PREFIX = 'analytics:top-entities';
const CACHE_TTL = 3600; // Cache for 1 hour

/**
 * Tính điểm thô cho một tổ chức dựa trên các chỉ số.
 * @param {object} metrics - Các chỉ số của tổ chức.
 * @param {number} metrics.article_count - Số lượng bài báo.
 * @param {number} metrics.citation_count - Tổng số trích dẫn.
 * @param {number} metrics.h_index - Chỉ số H-index trung bình của các tác giả.
 * @returns {number} Điểm thô.
 */
function calculateRawScore(metrics) {
  const articleWeight = 0.4;
  const citationWeight = 0.5;
  const hIndexWeight = 0.1; // Dùng H-index thay cho impact_score vì dễ tính hơn từ DB

  const score =
    (metrics.article_count || 0) * articleWeight +
    (metrics.citation_count || 0) * citationWeight +
    (metrics.h_index || 0) * hIndexWeight;

  return score;
}

/**
 * Chuẩn hóa điểm về thang 0-100.
 * @param {Array<object>} entities - Danh sách các tổ chức với điểm thô.
 * @returns {Array<object>} Danh sách các tổ chức với điểm đã chuẩn hóa.
 */
function normalizeScores(entities) {
  if (entities.length === 0) {
    return [];
  }

  const scores = entities.map((e) => e.rawScore);
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);

  if (maxScore === minScore) {
    return entities.map((e) => ({
      name: e.name,
      score: 100
    }));
  }

  return entities.map((e) => {
    const normalized = ((e.rawScore - minScore) / (maxScore - minScore)) * 100;
    return {
      name: e.name,
      score: Math.round(normalized * 10) / 10 // Làm tròn 1 chữ số thập phân
    };
  });
}

/**
 * Lấy danh sách các tổ chức hàng đầu dựa trên bộ lọc.
 * @param {object} filters
 * @param {string} filters.projectId
 * @param {string} [filters.entityType]
 * @param {number} [filters.fromYear]
 * @param {number} [filters.toYear]
 * @param {number} filters.limit
 * @returns {Promise<Array<{name: string, score: number}>>}
 */
export async function getTopEntities(filters) {
  // --- Caching Logic ---
  const { projectId, entityType, fromYear, toYear, limit } = filters;
  const cacheKeyParts = [
    CACHE_KEY_PREFIX,
    `project:${projectId}`,
    `limit:${limit}`
  ];
  if (entityType) cacheKeyParts.push(`type:${entityType}`);
  if (fromYear) cacheKeyParts.push(`from:${fromYear}`);
  if (toYear) cacheKeyParts.push(`to:${toYear}`);

  const cacheKey = cacheKeyParts.join(':');

  try {
    const cachedData = await redisGet(cacheKey);
    if (cachedData) {
      logger.info(`[Redis] Cache hit for top entities: ${cacheKey}`);
      return JSON.parse(cachedData);
    }
    logger.info(`[Redis] Cache miss for top entities: ${cacheKey}`);
  } catch (err) {
    logger.warn('Failed to get top entities from Redis, querying database:', err?.message || err);
  }

  const client = await pool.connect();
  try {
    // 1. Lấy phạm vi phân tích của project
    const scope = await getProjectScope(client, filters.projectId);
    if (scope.subjectCategoryIds.length === 0 && scope.keywordIds.length === 0) {
      logger.warn(`Project ${filters.projectId} has no scope. Returning empty top entities.`);
      return [];
    }

    // 2. Xây dựng câu truy vấn SQL
    const params = [];
    const whereClauses = [];

    // Lọc theo phạm vi project (subject categories và keywords)
    const scopeFilters = [];
    if (scope.subjectCategoryIds.length > 0) {
      params.push(scope.subjectCategoryIds);
      scopeFilters.push(`
        EXISTS (
          SELECT 1 FROM "Topic" t WHERE t.topic_id = a.primary_topic AND t.subject_category_id = ANY($${params.length}::bigint[])
        ) OR EXISTS (
          SELECT 1 FROM "Sub_Topic" st JOIN "Topic" t ON st.topic_id = t.topic_id
          WHERE st.article_id = a.article_id AND t.subject_category_id = ANY($${params.length}::bigint[])
        )
      `);
    }
    if (scope.keywordIds.length > 0) {
      params.push(scope.keywordIds);
      scopeFilters.push(`EXISTS (SELECT 1 FROM "Keyword_Article" ka WHERE ka.article_id = a.article_id AND ka.keyword_id = ANY($${params.length}::bigint[]))`);
    }
    whereClauses.push(`(${scopeFilters.join(' OR ')})`);

    // Lọc theo các tham số từ query
    if (filters.entityType) {
      params.push(filters.entityType);
      whereClauses.push(`i.type = $${params.length}`);
    }
    if (filters.fromYear) {
      params.push(filters.fromYear);
      whereClauses.push(`a.publication_year >= $${params.length}`);
    }
    if (filters.toYear) {
      params.push(filters.toYear);
      whereClauses.push(`a.publication_year <= $${params.length}`);
    }

    const query = `
      SELECT
        i.display_name AS name,
        COUNT(DISTINCT a.article_id) AS article_count,
        COALESCE(SUM(a.citation_count), 0) AS citation_count,
        COALESCE(AVG(au.h_index), 0) AS h_index
      FROM "Institution" i
      JOIN "Institution_Author" ia ON i.institution_id = ia.institution_id
      JOIN "Author" au ON ia.author_id = au.author_id
      JOIN "Author_Article" aa ON au.author_id = aa.author_id
      JOIN "Article" a ON aa.article_id = a.article_id
      WHERE ${whereClauses.join(' AND ')}
        AND COALESCE(a.is_deleted, false) = false
        AND COALESCE(i.is_deleted, false) = false
      GROUP BY i.institution_id, i.display_name
    `;

    const result = await client.query(query, params);

    // 3. Tính điểm và chuẩn hóa
    const entitiesWithRawScore = result.rows.map(row => ({
      name: row.name,
      rawScore: calculateRawScore(row)
    }));

    const results = normalizeScores(entitiesWithRawScore);

    // 4. Sắp xếp và giới hạn kết quả
    const finalData = results
      .sort((a, b) => b.score - a.score)
      .slice(0, filters.limit);

    // --- Save to cache before returning ---
    try {
      await redisSet(cacheKey, JSON.stringify(finalData), CACHE_TTL);
      logger.info(`[Redis] Top entities cached: ${cacheKey}`);
    } catch (err) {
      logger.warn('Failed to set top entities in Redis cache:', err?.message || err);
    }

    return finalData;
  } finally {
    client.release();
  }
}