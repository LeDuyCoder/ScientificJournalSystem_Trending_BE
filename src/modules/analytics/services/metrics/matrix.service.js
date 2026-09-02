import pool from '../../../../config/database.js';
import logger from '../../../../utils/logger.js';
import { redisGet, redisSet } from '../../../core/services/infrastructure/redis.service.js';

const CACHE_KEY_PREFIX = 'matrix:intensity:v2';
const CACHE_TTL = 43200; // 12 hours // 10 minutes

/**
 * Parse comma-separated keywords into clean array.
 */
function parseKeywordFilter(keywords) {
  if (!keywords) return [];
  const list = Array.isArray(keywords) ? keywords : String(keywords).split(',');
  return list.map(k => String(k).trim()).filter(Boolean);
}

/**
 * Get Topic Intensity Matrix using pure PostgreSQL.
 *
 * Architecture:
 *   1. Resolve project scope (subject_category_ids, keyword_ids)
 *   2. Filter related articles using scope + custom filters
 *   3. Select top rows (authors or institutions) by article count
 *   4. Select top topics by article count
 *   5. Build full matrix (row x topic) with article counts
 *   6. Normalize intensity per row: intensity = count / maxCountOfRow
 *
 * @param {object} options
 * @returns {Promise<Array<{rowName: string, topic: string, intensity: number}>>}
 */
export async function getTopicIntensityMatrix(options = {}) {
  const {
    project_id,
    subject_area,
    keywords,
    from_year,
    to_year,
    limit_rows = 10,
    limit_topics = 8,
  } = options;

  const row_type = (options.row_type || 'author').trim().toLowerCase();

  // ── Validation ──
  if (!project_id || project_id === 'undefined' || project_id === 'null') {
    const error = new Error('project_id is required');
    error.status = 400;
    throw error;
  }

  if (row_type !== 'author' && row_type !== 'institution') {
    const error = new Error('Invalid row_type');
    error.status = 400;
    throw error;
  }

  const fromYear = from_year ? parseInt(from_year, 10) : undefined;
  const toYear = to_year ? parseInt(to_year, 10) : undefined;

  if (fromYear && toYear && fromYear > toYear) {
    const error = new Error('Invalid year range');
    error.status = 400;
    throw error;
  }

  const limitRows = Number(limit_rows);
  if (!limitRows || limitRows <= 0 || limitRows > 50) {
    const error = new Error('Invalid limit_rows');
    error.status = 400;
    throw error;
  }

  const limitTopics = Number(limit_topics);
  if (!limitTopics || limitTopics <= 0 || limitTopics > 30) {
    const error = new Error('Invalid limit_topics');
    error.status = 400;
    throw error;
  }

  const keywordList = parseKeywordFilter(keywords);
  const normalizedKeywords = [...keywordList].map(s => s.toLowerCase()).sort().join(',');

  // ── Redis Cache ──
  const cacheKey = `${CACHE_KEY_PREFIX}:${project_id}:${row_type}:${(subject_area || '').toLowerCase()}:${normalizedKeywords}:${fromYear || ''}:${toYear || ''}:${limitRows}:${limitTopics}`;

  try {
    const cachedData = await redisGet(cacheKey);
    if (cachedData) {
      logger.info(`[Redis] Cache hit for matrix intensity: ${cacheKey}`);
      return JSON.parse(cachedData);
    }
    logger.info(`[Redis] Cache miss for matrix intensity: ${cacheKey}`);
  } catch (err) {
    logger.warn('Failed to get matrix data from Redis, querying database:', err?.message || err);
  }

  // ── Cache result ──
  const client = await pool.connect();
  try {
    // ════════════════════════════════════════════════════════════
    // STEP 1: Resolve Project Scope
    // ════════════════════════════════════════════════════════════
    const projectRes = await client.query(
      `SELECT project_id, subject_area FROM "Project" WHERE project_id = $1`,
      [project_id]
    );
    if (projectRes.rows.length === 0) {
      const error = new Error('Project not found');
      error.status = 404;
      throw error;
    }

    const projectSubjectAreaId = projectRes.rows[0].subject_area;

    const categoriesRes = await client.query(
      `SELECT subject_category_id FROM "Subject_Category" WHERE subject_area_id = $1 AND COALESCE(is_deleted, false) = false`,
      [projectSubjectAreaId]
    );
    const scopeCategoryIds = categoriesRes.rows.map(r => Number(r.subject_category_id));

    const keywordsRes = await client.query(
      `SELECT keyword_id FROM "Project_Keyword" WHERE project_id = $1`,
      [project_id]
    );
    const scopeKeywordIds = keywordsRes.rows.map(r => Number(r.keyword_id));

    if (scopeCategoryIds.length === 0 && scopeKeywordIds.length === 0) {
      return [];
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
    if (fromYear) {
      params.push(fromYear);
      yearFilters.push(`a.publication_year >= $${params.length}`);
    }
    if (toYear) {
      params.push(toYear);
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
      SELECT a.article_id, a.publication_year, a.primary_topic
      FROM "Article" a
      ${joins.join('\n      ')}
      WHERE COALESCE(a.is_deleted, false) = false
        ${yearSql}
    )`);

    const cteSql = `WITH ${cteParts.join(',\n')}`;

    // ════════════════════════════════════════════════════════════
    // STEP 3: Select Top Rows (Authors) by total article count
    // ════════════════════════════════════════════════════════════
    const topRowsParamIdx = params.length + 1;
    params.push(limitRows);

    let topRowsSql = '';
    if (row_type === 'author') {
      topRowsSql = `
        ${cteSql}
        SELECT au.author_id AS row_id, 
               COALESCE(au.display_name, 'Unknown Author') AS row_name, 
               COUNT(DISTINCT a.article_id) AS total_articles
        FROM filtered_articles a
        JOIN "Author_Article" aa ON a.article_id = aa.article_id
        JOIN "Author" au ON aa.author_id = au.author_id
        GROUP BY au.author_id, au.display_name
        ORDER BY total_articles DESC
        LIMIT $${topRowsParamIdx}
      `;
    } else {
      topRowsSql = `
        ${cteSql}
        SELECT inst.institution_id AS row_id, 
               COALESCE(inst.display_name, 'Unknown Institution') AS row_name, 
               COUNT(DISTINCT a.article_id) AS total_articles
        FROM filtered_articles a
        JOIN "Author_Article" aa ON a.article_id = aa.article_id
        JOIN "Institution_Author" ia ON aa.author_id = ia.author_id AND a.publication_year = ia.year
        JOIN "Institution" inst ON ia.institution_id = inst.institution_id
        WHERE COALESCE(inst.is_deleted, false) = false
        GROUP BY inst.institution_id, inst.display_name
        ORDER BY total_articles DESC
        LIMIT $${topRowsParamIdx}
      `;
    }

    const topRowsRes = await client.query(topRowsSql, params);
    const rows = topRowsRes.rows;

    if (rows.length === 0) {
      return [];
    }

    // ════════════════════════════════════════════════════════════
    // STEP 4: Select Top Topics by total article count
    // ════════════════════════════════════════════════════════════
    // Remove limitRows param, replace with limitTopics for topic query
    const topicParams = params.slice(0, -1); // remove last limitRows
    topicParams.push(limitTopics);
    const topicParamIdx = topicParams.length;

    const topTopicsSql = `
      ${cteSql},
      article_topics AS (
        SELECT article_id, primary_topic AS topic_id
        FROM filtered_articles
        WHERE primary_topic IS NOT NULL
        UNION
        SELECT fa.article_id, st.topic_id
        FROM filtered_articles fa
        JOIN "Sub_Topic" st ON fa.article_id = st.article_id
      )
      SELECT t.topic_id, 
             COALESCE(t.display_name, 'Unknown Topic') AS topic_name, 
             COUNT(DISTINCT at.article_id) AS total_articles
      FROM article_topics at
      JOIN "Topic" t ON t.topic_id = at.topic_id
      GROUP BY t.topic_id, t.display_name
      ORDER BY total_articles DESC
      LIMIT $${topicParamIdx}
    `;

    const topTopicsRes = await client.query(topTopicsSql, topicParams);
    const topics = topTopicsRes.rows;

    if (topics.length === 0) {
      return [];
    }

    // ════════════════════════════════════════════════════════════
    // STEP 5: Build matrix cells (Row x Topic -> count)
    // ════════════════════════════════════════════════════════════
    const selectedRowIds = rows.map(r => Number(r.row_id));
    const selectedTopicIds = topics.map(t => Number(t.topic_id));

    const matrixParams = params.slice(0, -1); // base filter params only (remove limitRows)
    matrixParams.push(selectedRowIds);
    const rowIdsIdx = matrixParams.length;
    matrixParams.push(selectedTopicIds);
    const topicIdsIdx = matrixParams.length;

    let matrixSql = '';
    if (row_type === 'author') {
      matrixSql = `
        ${cteSql},
        article_topics AS (
          SELECT article_id, primary_topic AS topic_id
          FROM filtered_articles
          WHERE primary_topic IS NOT NULL
          UNION
          SELECT fa.article_id, st.topic_id
          FROM filtered_articles fa
          JOIN "Sub_Topic" st ON fa.article_id = st.article_id
        )
        SELECT au.author_id AS row_id, 
               t.topic_id AS topic_id, 
               COUNT(DISTINCT at.article_id) AS cnt
        FROM article_topics at
        JOIN "Author_Article" aa ON at.article_id = aa.article_id
        JOIN "Author" au ON aa.author_id = au.author_id
        JOIN "Topic" t ON t.topic_id = at.topic_id
        WHERE au.author_id = ANY($${rowIdsIdx}::bigint[])
          AND t.topic_id = ANY($${topicIdsIdx}::bigint[])
        GROUP BY au.author_id, t.topic_id
      `;
    } else {
      matrixSql = `
        ${cteSql},
        article_topics AS (
          SELECT article_id, primary_topic AS topic_id, publication_year
          FROM filtered_articles
          WHERE primary_topic IS NOT NULL
          UNION
          SELECT fa.article_id, st.topic_id, fa.publication_year
          FROM filtered_articles fa
          JOIN "Sub_Topic" st ON fa.article_id = st.article_id
        )
        SELECT inst.institution_id AS row_id, 
               t.topic_id AS topic_id, 
               COUNT(DISTINCT at.article_id) AS cnt
        FROM article_topics at
        JOIN "Author_Article" aa ON at.article_id = aa.article_id
        JOIN "Institution_Author" ia ON aa.author_id = ia.author_id AND at.publication_year = ia.year
        JOIN "Institution" inst ON ia.institution_id = inst.institution_id
        JOIN "Topic" t ON t.topic_id = at.topic_id
        WHERE inst.institution_id = ANY($${rowIdsIdx}::bigint[])
          AND t.topic_id = ANY($${topicIdsIdx}::bigint[])
          AND COALESCE(inst.is_deleted, false) = false
        GROUP BY inst.institution_id, t.topic_id
      `;
    }

    const matrixRes = await client.query(matrixSql, matrixParams);

    // ════════════════════════════════════════════════════════════
    // STEP 6: Build full Cartesian product + Global normalization
    // ════════════════════════════════════════════════════════════
    const countsMap = new Map();
    let globalMaxCount = 0;
    
    matrixRes.rows.forEach(r => {
      const cnt = Number(r.cnt);
      countsMap.set(`${r.row_id}-${r.topic_id}`, cnt);
      if (cnt > globalMaxCount) globalMaxCount = cnt;
    });

    // Build full matrix: every row x every topic
    const data = [];
    rows.forEach(r => {
      topics.forEach(t => {
        const count = countsMap.get(`${r.row_id}-${t.topic_id}`) || 0;
        let intensity = 0;
        if (globalMaxCount > 0) {
          intensity = Number((count / globalMaxCount).toFixed(3));
        }
        data.push({
          rowName: r.row_name,
          topic: t.topic_name,
          intensity,
        });
      });
    });

    // ── Cache result ──
    try {
      await redisSet(cacheKey, JSON.stringify(data), CACHE_TTL);
      logger.info(`[Redis] Matrix intensity cached: ${cacheKey}`);
    } catch (err) {
      logger.warn('Failed to set matrix data in Redis cache:', err?.message || err);
    }

    return data;
  } catch (error) {
    logger.error('Error fetching topic intensity matrix:', error);
    if (error.status) {
      throw error;
    }
    throw new Error('An internal error occurred while fetching topic intensity matrix.');
  } finally {
    client.release();
  }
}
