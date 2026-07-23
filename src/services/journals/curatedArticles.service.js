import pool from '../../config/database.js';
import { redisGet, redisSet } from '../infrastructure/redis.service.js';
import { redisClient } from '../../config/redis.js';

import logger from '../../utils/logger.js';

const CACHE_TTL = 43200; // 12 hours

// Helper: Xóa cache liên quan đến project
async function invalidateProjectCache(projectId) {
  try {
    const keys = await redisClient.keys(`*analytics*${projectId}*`);
    if (keys && keys.length > 0) {
      await redisClient.del(keys);
      logger.info(`[Cache Invalidation] Deleted ${keys.length} keys for project ${projectId}`);
    }
  } catch (err) {
    logger.warn('[Cache Invalidation] Failed:', err);
  }
}

/**
 * Service to fetch curated articles for a given project.
 */
export async function getCuratedArticles(projectId, options = {}) {
  const { page = 1, limit = 10, subject_area, keywords, from_year, to_year, is_open_access } = options;
  const offset = (page - 1) * limit;

  const cacheKey = `analytics:curated-articles:${projectId}:${page}:${limit}:${subject_area || ''}:${keywords || ''}:${from_year || ''}:${to_year || ''}:${is_open_access || ''}`;
  try {
    const cached = await redisGet(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (e) {
    logger.warn('Redis error:', e);
  }

  const client = await pool.connect();

  try {
    // 1. Resolve Project Scope
    const projectRes = await client.query(
      `SELECT project_id, subject_area FROM "Project" WHERE project_id = $1`,
      [projectId]
    );
    if (projectRes.rows.length === 0) {
      return { total: 0, items: [], totalPages: 0, currentPage: page };
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
      return { total: 0, items: [], totalPages: 0, currentPage: page };
    }

    const params = [];
    const projectArticlesCTE = [];

    if (scopeCategoryIds.length > 0) {
      params.push(scopeCategoryIds);
      const catIdx = params.length;
      projectArticlesCTE.push(`
        SELECT a.article_id, a.primary_topic, a.issue_id, a.publication_year, a.created_at
        FROM "Article" a
        JOIN "Topic" t ON a.primary_topic = t.topic_id
        WHERE t.subject_category_id = ANY($${catIdx}::bigint[])
          AND COALESCE(a.is_deleted, false) = false
        UNION
        SELECT a.article_id, a.primary_topic, a.issue_id, a.publication_year, a.created_at
        FROM "Sub_Topic" st
        JOIN "Topic" t ON st.topic_id = t.topic_id
        JOIN "Article" a ON st.article_id = a.article_id
        WHERE t.subject_category_id = ANY($${catIdx}::bigint[])
          AND COALESCE(a.is_deleted, false) = false
      `);
    }

    if (scopeKeywordIds.length > 0) {
      params.push(scopeKeywordIds);
      const kwIdx = params.length;
      projectArticlesCTE.push(`
        SELECT ka.article_id, a.primary_topic, a.issue_id, a.publication_year, a.created_at
        FROM "Keyword_Article" ka
        JOIN "Article" a ON ka.article_id = a.article_id
        WHERE ka.keyword_id = ANY($${kwIdx}::bigint[])
          AND COALESCE(a.is_deleted, false) = false
      `);
    }

    const projectScopeQuery = projectArticlesCTE.join(' UNION ');

    // 2. Build Custom Filters
    const articleFilters = [];
    const keywordList = (keywords || '').split(',').map(s => s.trim()).filter(Boolean);

    if (subject_area) {
      params.push(subject_area.trim().toLowerCase());
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
    if (from_year) {
      params.push(from_year);
      articleFilters.push(`a.publication_year >= $${params.length}`);
    }
    if (to_year) {
      params.push(to_year);
      articleFilters.push(`a.publication_year <= $${params.length}`);
    }
    if (is_open_access === 'true' || is_open_access === true) {
      articleFilters.push(`EXISTS (
        SELECT 1 FROM "Issue" i
        JOIN "Volume" v ON i.volume_id = v.volume_id
        JOIN "Journal" j ON v.journal_id = j.journal_id
        WHERE i.issue_id = a.issue_id AND COALESCE(j.is_open_access, false) = true
      )`);
    }

    const whereClause = articleFilters.length > 0 ? `AND ${articleFilters.join(' AND ')}` : '';

    // 3. Get total count
    const countQuery = `
      WITH project_articles AS ( ${projectScopeQuery} )
      SELECT COUNT(a.article_id) as total
      FROM project_articles a
      WHERE 1=1 ${whereClause}
    `;
    const countRes = await client.query(countQuery, params);
    const total = Number(countRes.rows[0].total) || 0;
    const totalPages = Math.ceil(total / limit);

    if (total === 0) {
      const emptyRes = { total: 0, items: [], totalPages: 0, currentPage: page };
      await redisSet(cacheKey, JSON.stringify(emptyRes), CACHE_TTL).catch(e => console.warn(e));
      return emptyRes;
    }

    // 4. Fetch paginated data
    params.push(limit, offset);
    const dataQuery = `
      WITH project_articles AS ( ${projectScopeQuery} ),
      paginated_articles AS (
        SELECT article_id, issue_id, publication_year, created_at
        FROM project_articles a
        WHERE 1=1 ${whereClause}
        ORDER BY a.publication_year DESC NULLS LAST, a.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
      )
      SELECT 
        pa.article_id AS id,
        full_a.title,
        full_a.abstract AS description,
        pa.publication_year AS "publishedYear",
        COALESCE(j.is_open_access, false) AS "isOpenAccess",
        (
          SELECT string_agg(au.display_name, ', ')
          FROM "Author_Article" aa
          JOIN "Author" au ON aa.author_id = au.author_id
          WHERE aa.article_id = pa.article_id
        ) AS authors,
        (
          SELECT string_agg(k.display_name, ', ')
          FROM "Keyword_Article" ka
          JOIN "Keyword" k ON ka.keyword_id = k.keyword_id
          WHERE ka.article_id = pa.article_id
        ) AS keywords
      FROM paginated_articles pa
      JOIN "Article" full_a ON pa.article_id = full_a.article_id
      LEFT JOIN "Issue" i ON pa.issue_id = i.issue_id
      LEFT JOIN "Volume" v ON i.volume_id = v.volume_id
      LEFT JOIN "Journal" j ON v.journal_id = j.journal_id
      ORDER BY pa.publication_year DESC NULLS LAST, pa.created_at DESC
    `;

    const dataRes = await client.query(dataQuery, params);

    const items = dataRes.rows.map(row => ({
      id: row.id,
      title: row.title,
      description: row.description,
      publishedYear: row.publishedYear || row.publishedyear,
      isOpenAccess: row.isOpenAccess === true || row.isOpenAccess === 'true' || row.isopenaccess === true || row.isopenaccess === 'true' || row.is_open_access === true,
      authors: row.authors || 'Unknown Authors',
      keywords: row.keywords || '',
      isBookmarked: false 
    }));

    const finalRes = { total, totalPages, currentPage: page, items };
    await redisSet(cacheKey, JSON.stringify(finalRes), CACHE_TTL).catch(e => console.warn(e));
    return finalRes;

  } finally {
    client.release();
  }
}

/**
 * Service to fetch keywords tracked by a given project.
 */
export async function getProjectKeywords(projectId) {
  const cacheKey = `analytics:project-keywords:${projectId}`;
  try {
    const cached = await redisGet(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (e) {
    console.warn(e);
  }

  const client = await pool.connect();
  try {
    const query = `
      SELECT k.keyword_id AS id, k.display_name AS label
      FROM "Project_Keyword" pk
      JOIN "Keyword" k ON pk.keyword_id = k.keyword_id
      WHERE pk.project_id = $1
    `;
    const res = await client.query(query, [projectId]);
    const items = res.rows;
    await redisSet(cacheKey, JSON.stringify(items), CACHE_TTL).catch(e => console.warn(e));
    return items;
  } finally {
    client.release();
  }
}

/**
 * Service to add a keyword to a project's tracked keywords.
 */
export async function addProjectKeyword(projectId, keywordName) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cleanName = keywordName.trim();
    let keywordRes = await client.query('SELECT keyword_id FROM "Keyword" WHERE LOWER(display_name) = $1', [cleanName.toLowerCase()]);
    let keywordId;
    if (keywordRes.rows.length > 0) {
      keywordId = keywordRes.rows[0].keyword_id;
    } else {
      const insertRes = await client.query('INSERT INTO "Keyword" (display_name) VALUES ($1) RETURNING keyword_id', [cleanName]);
      keywordId = insertRes.rows[0].keyword_id;
    }
    
    const checkRes = await client.query('SELECT 1 FROM "Project_Keyword" WHERE project_id = $1 AND keyword_id = $2', [projectId, keywordId]);
    if (checkRes.rows.length === 0) {
      await client.query('INSERT INTO "Project_Keyword" (project_id, keyword_id) VALUES ($1, $2)', [projectId, keywordId]);
    }
    await client.query('COMMIT');
    
    // Invalidate project caches because scope changed
    await invalidateProjectCache(projectId);
    
    return { id: keywordId, label: cleanName };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Service to remove a keyword from a project's tracked keywords.
 */
export async function removeProjectKeyword(projectId, keywordId) {
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM "Project_Keyword" WHERE project_id = $1 AND keyword_id = $2', [projectId, keywordId]);
    
    // Invalidate project caches because scope changed
    await invalidateProjectCache(projectId);
  } finally {
    client.release();
  }
}

/**
 * Service to fetch journals associated with the curated articles of a project.
 */
export async function getTrackedJournals(projectId) {
  const cacheKey = `analytics:tracked-journals:${projectId}`;
  try {
    const cached = await redisGet(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (e) {
    console.warn(e);
  }

  const client = await pool.connect();
  try {
    const projectRes = await client.query(`SELECT project_id, subject_area FROM "Project" WHERE project_id = $1`, [projectId]);
    if (projectRes.rows.length === 0) return [];
    
    const projectSubjectAreaId = projectRes.rows[0].subject_area;

    const categoriesRes = await client.query(`SELECT subject_category_id FROM "Subject_Category" WHERE subject_area_id = $1 AND COALESCE(is_deleted, false) = false`, [projectSubjectAreaId]);
    const scopeCategoryIds = categoriesRes.rows.map(r => Number(r.subject_category_id));

    const keywordsRes = await client.query(`SELECT keyword_id FROM "Project_Keyword" WHERE project_id = $1`, [projectId]);
    const scopeKeywordIds = keywordsRes.rows.map(r => Number(r.keyword_id));

    if (scopeCategoryIds.length === 0 && scopeKeywordIds.length === 0) return [];

    const params = [];
    const projectArticlesCTE = [];

    if (scopeCategoryIds.length > 0) {
      params.push(scopeCategoryIds);
      const catIdx = params.length;
      projectArticlesCTE.push(`
        SELECT a.article_id, a.issue_id
        FROM "Article" a
        JOIN "Topic" t ON a.primary_topic = t.topic_id
        WHERE t.subject_category_id = ANY($${catIdx}::bigint[])
          AND COALESCE(a.is_deleted, false) = false
        UNION
        SELECT a.article_id, a.issue_id
        FROM "Sub_Topic" st
        JOIN "Topic" t ON st.topic_id = t.topic_id
        JOIN "Article" a ON st.article_id = a.article_id
        WHERE t.subject_category_id = ANY($${catIdx}::bigint[])
          AND COALESCE(a.is_deleted, false) = false
      `);
    }

    if (scopeKeywordIds.length > 0) {
      params.push(scopeKeywordIds);
      const kwIdx = params.length;
      projectArticlesCTE.push(`
        SELECT ka.article_id, a.issue_id
        FROM "Keyword_Article" ka
        JOIN "Article" a ON ka.article_id = a.article_id
        WHERE ka.keyword_id = ANY($${kwIdx}::bigint[])
          AND COALESCE(a.is_deleted, false) = false
      `);
    }

    const projectScopeQuery = projectArticlesCTE.join(' UNION ');

    const query = `
      WITH project_articles AS ( ${projectScopeQuery} ),
      project_journals AS (
        SELECT DISTINCT j.journal_id, j.display_name AS name, j.issn
        FROM project_articles a
        JOIN "Issue" i ON a.issue_id = i.issue_id
        JOIN "Volume" v ON i.volume_id = v.volume_id
        JOIN "Journal" j ON v.journal_id = j.journal_id
        WHERE COALESCE(j.is_deleted, false) = false 
      ),
      journal_sjr AS (
        SELECT jr.journal_id, jr.value_float AS sjr_score, ROW_NUMBER() OVER (PARTITION BY jr.journal_id ORDER BY jr.year DESC) AS rn
        FROM "Journal_Ranking" jr
        JOIN "Ranking_Metric" rm ON jr.metric_id = rm.metric_id
        WHERE rm.code = 'SJR' AND jr.journal_id IN (SELECT journal_id FROM project_journals)
      ),
      journal_quartile AS (
        SELECT jr.journal_id, jr.value_txt AS quartile, ROW_NUMBER() OVER (PARTITION BY jr.journal_id ORDER BY jr.year DESC) AS rn
        FROM "Journal_Ranking" jr
        JOIN "Ranking_Metric" rm ON jr.metric_id = rm.metric_id
        WHERE rm.code = 'SJR_BEST_QUARTILE' AND jr.journal_id IN (SELECT journal_id FROM project_journals)
      )
      SELECT
        pj.journal_id AS id,
        pj.name,
        pj.issn,
        COALESCE(js.sjr_score, 0) AS "impactFactor",
        COALESCE(jq.quartile, 'N/A') AS "sjrRank"
      FROM project_journals pj
      LEFT JOIN journal_sjr js ON pj.journal_id = js.journal_id AND js.rn = 1
      LEFT JOIN journal_quartile jq ON pj.journal_id = jq.journal_id AND jq.rn = 1
      ORDER BY "impactFactor" DESC NULLS LAST, pj.name ASC
      LIMIT 10
    `;
    const dataRes = await client.query(query, params);

    const items = dataRes.rows.map(row => ({
      id: row.id,
      name: row.name,
      publisher: 'Unknown Publisher',
      issn: row.issn || 'N/A',
      impactFactor: row.impactFactor ? parseFloat(row.impactFactor) : 0,
      sjrRank: row.sjrRank || 'N/A',
      trend: [0, 1, 2, 1, 3, 2, 4], 
      cover: `https://via.placeholder.com/48x64/f1f5f9/1a1a1a?text=${(row.name || 'JNL').substring(0, 3).toUpperCase()}`
    }));

    await redisSet(cacheKey, JSON.stringify(items), CACHE_TTL).catch(e => console.warn(e));
    return items;
  } finally {
    client.release();
  }
}
