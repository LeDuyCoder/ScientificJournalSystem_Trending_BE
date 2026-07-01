import pool from '../config/database.js';
import { redisGet, redisSet } from './redis.service.js';
import logger from '../../utils/logger.js';

const CACHE_TTL = 180; // 3 minutes

/**
 * Hàm phân tích và làm sạch keywords
 */
function prepareKeywords(keywords) {
  if (!keywords) return [];
  const list = Array.isArray(keywords) ? keywords : String(keywords).split(',');
  return list.map(k => String(k).trim()).filter(Boolean);
}

/**
 * Hàm chuẩn hoá chuỗi thời gian (timeline) và đảm bảo các năm thiếu được điền giá trị 0
 */
function normalizeTrendSeries(records, from_year, to_year) {
  const timeline = [];
  const articlesData = [];
  const citationsData = [];
  
  if (records.length === 0) {
    return { timeline, series: [{ name: 'Articles', data: [] }, { name: 'Citations', data: [] }] };
  }

  // Calculate year bounds
  const dbMinYear = Math.min(...records.map(r => r.year));
  const dbMaxYear = Math.max(...records.map(r => r.year));
  
  const minYear = (from_year && !isNaN(Number(from_year))) ? Number(from_year) : dbMinYear;
  const maxYear = (to_year && !isNaN(Number(to_year))) ? Number(to_year) : dbMaxYear;

  const recordsMap = {};
  for (const r of records) {
    recordsMap[r.year] = r;
  }

  for (let y = minYear; y <= maxYear; y++) {
    timeline.push(String(y));
    if (recordsMap[y]) {
      articlesData.push(recordsMap[y].articles);
      citationsData.push(recordsMap[y].citations);
    } else {
      articlesData.push(0);
      citationsData.push(0);
    }
  }

  const series = [
    { name: 'Articles', data: articlesData },
    { name: 'Citations', data: citationsData }
  ];

  return { timeline, series };
}

export async function getPublicationTrends(options = {}) {
  const { project_id, subject_area, subject_category, keywords, from_year, to_year } = options;

  const keywordList = prepareKeywords(keywords);
  const normalizedKeywords = [...keywordList].map(s => s.toLowerCase()).sort().join(',');

  const cacheKey = `analytics:trends:v2:${project_id || 'all'}:${(subject_area || '').toLowerCase()}:${(subject_category || '').toLowerCase()}:${normalizedKeywords}:${from_year || ''}:${to_year || ''}`;

  try {
    const cachedData = await redisGet(cacheKey);
    if (cachedData) {
      return JSON.parse(cachedData);
    }
  } catch (err) {
    logger.warn('Failed to get trend data from Redis cache:', err?.message || err);
  }

  const client = await pool.connect();

  try {
    const params = [];
    const sqlFilters = [];

    // --- Xử lý Project Scope (Nếu có project_id hợp lệ) ---
    if (project_id && project_id !== 'undefined' && project_id !== 'null') {
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

      const categoriesRes = await client.query(
        `SELECT subject_category_id FROM "Subject_Category" WHERE subject_area_id = $1 AND COALESCE(is_deleted, false) = false`,
        [project.subject_area]
      );
      const projectCategoryIds = categoriesRes.rows.map(r => Number(r.subject_category_id));

      const keywordsRes = await client.query(
        `SELECT keyword_id FROM "Project_Keyword" WHERE project_id = $1`,
        [project_id]
      );
      const projectKeywordIds = keywordsRes.rows.map(r => Number(r.keyword_id));

      if (projectCategoryIds.length === 0 && projectKeywordIds.length === 0) {
        return { timeline: [], series: [{ name: 'Articles', data: [] }, { name: 'Citations', data: [] }] };
      }

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
        return { timeline: [], series: [{ name: 'Articles', data: [] }, { name: 'Citations', data: [] }] };
      }
    }

    // --- Client custom filter: subject_category ---
    if (subject_category) {
      const catRes = await client.query(
        `SELECT subject_category_id FROM "Subject_Category" 
         WHERE (LOWER(display_name) = LOWER($1) OR subject_category_id::text = $1)
           AND COALESCE(is_deleted, false) = false`,
        [subject_category.trim()]
      );

      if (catRes.rows.length === 0) {
        return { timeline: [], series: [{ name: 'Articles', data: [] }, { name: 'Citations', data: [] }] };
      }

      const categoryId = Number(catRes.rows[0].subject_category_id);
      params.push([categoryId]);
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

    // --- Client custom filter: subject_area ---
    if (subject_area) {
      const saRes = await client.query(
        `SELECT subject_area_id FROM "Subject_Area" WHERE LOWER(display_name) = LOWER($1) AND COALESCE(is_deleted, false) = false`,
        [subject_area.trim()]
      );

      if (saRes.rows.length === 0) {
        return { timeline: [], series: [{ name: 'Articles', data: [] }, { name: 'Citations', data: [] }] };
      }

      const saId = saRes.rows[0].subject_area_id;

      const scRes = await client.query(
        `SELECT subject_category_id FROM "Subject_Category" WHERE subject_area_id = $1 AND COALESCE(is_deleted, false) = false`,
        [saId]
      );
      const filterCategoryIds = scRes.rows.map(r => Number(r.subject_category_id));

      if (filterCategoryIds.length === 0) {
        return { timeline: [], series: [{ name: 'Articles', data: [] }, { name: 'Citations', data: [] }] };
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

    // --- Client custom filter: keywords ---
    if (keywordList.length > 0) {
      const kwRes = await client.query(
        `SELECT keyword_id FROM "Keyword" WHERE LOWER(display_name) = ANY($1::text[])`,
        [keywordList.map(s => s.toLowerCase())]
      );
      const filterKeywordIds = kwRes.rows.map(r => Number(r.keyword_id));

      if (filterKeywordIds.length === 0) {
        return { timeline: [], series: [{ name: 'Articles', data: [] }, { name: 'Citations', data: [] }] };
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
    if (from_year !== undefined && from_year !== null && from_year !== '') {
      params.push(Number(from_year));
      sqlFilters.push(`a.publication_year >= $${params.length}`);
    }
    if (to_year !== undefined && to_year !== null && to_year !== '') {
      params.push(Number(to_year));
      sqlFilters.push(`a.publication_year <= $${params.length}`);
    }

    const whereClause = sqlFilters.length > 0 ? `AND ${sqlFilters.join(' AND ')}` : '';

    const querySql = `
      SELECT 
        a.publication_year AS year, 
        COUNT(DISTINCT a.article_id)::integer AS articles,
        COALESCE(SUM(a.citation_count), 0)::integer AS citations
      FROM "Article" a
      WHERE COALESCE(a.is_deleted, false) = false
        AND a.publication_year IS NOT NULL
        ${whereClause}
      GROUP BY a.publication_year
      ORDER BY a.publication_year ASC
    `;

    const result = await client.query(querySql, params);
    
    const records = result.rows.map(row => ({
      year: Number(row.year),
      articles: row.articles,
      citations: row.citations
    }));

    const finalResult = normalizeTrendSeries(records, from_year, to_year);

    try {
      await redisSet(cacheKey, JSON.stringify(finalResult), CACHE_TTL);
    } catch (err) {
      logger.warn('Failed to set trend data in Redis cache:', err?.message || err);
    }

    return finalResult;
  } finally {
    client.release();
  }
}
