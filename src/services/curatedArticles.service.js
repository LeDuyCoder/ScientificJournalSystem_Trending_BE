import pool from '../config/database.js';

/**
 * Service to fetch curated articles for a given project.
 * @param {string|number} projectId
 * @param {object} options
 * @returns {Promise<object>}
 */
export async function getCuratedArticles(projectId, options = {}) {
  const { page = 1, limit = 10, subject_area, keywords, from_year, to_year } = options;
  const offset = (page - 1) * limit;

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

    // 2. Build Article Filter
    const params = [];
    const articleFilters = [];
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
    if (options.is_open_access === 'true' || options.is_open_access === true) {
      articleFilters.push(`EXISTS (
        SELECT 1 FROM "Issue" i
        JOIN "Volume" v ON i.volume_id = v.volume_id
        JOIN "Journal" j ON v.journal_id = j.journal_id
        WHERE i.issue_id = a.issue_id AND COALESCE(j.is_open_access, false) = true
      )`);
    }

    const whereClause = articleFilters.join(' AND ');

    // 3. Get total count
    const countQuery = `
      SELECT COUNT(a.article_id) as total
      FROM "Article" a
      WHERE COALESCE(a.is_deleted, false) = false AND ${whereClause}
    `;
    const countRes = await client.query(countQuery, params);
    const total = Number(countRes.rows[0].total) || 0;
    const totalPages = Math.ceil(total / limit);

    if (total === 0) {
      return { total: 0, items: [], totalPages: 0, currentPage: page };
    }

    // 4. Fetch paginated data
    const pIdIndex = params.length + 1;
    params.push(projectId);
    const uIdIndex = params.length + 1;
    params.push(options.userId || '00000000-0000-0000-0000-000000000000');
    
    const limitIndex = params.length + 1;
    params.push(limit);
    const offsetIndex = params.length + 1;
    params.push(offset);
    
    const dataQuery = `
      SELECT 
        a.article_id AS id,
        a.title,
        a.abstract AS description,
        a.publication_year AS "publishedYear",
        a.doi,
        COALESCE(j.is_open_access, false) AS "isOpenAccess",
        (
          SELECT string_agg(au.display_name, ', ')
          FROM "Author_Article" aa
          JOIN "Author" au ON aa.author_id = au.author_id
          WHERE aa.article_id = a.article_id
        ) AS authors,
        (
          SELECT string_agg(k.display_name, ', ')
          FROM "Keyword_Article" ka
          JOIN "Keyword" k ON ka.keyword_id = k.keyword_id
          WHERE ka.article_id = a.article_id
        ) AS keywords,
        EXISTS (
          SELECT 1 FROM "Project_Article_Bookmark" pab
          WHERE pab.article_id = a.article_id 
            AND pab.project_id = $${pIdIndex} 
            AND pab.user_id = $${uIdIndex}
        ) AS "isBookmarked"
      FROM "Article" a
      LEFT JOIN "Issue" i ON a.issue_id = i.issue_id
      LEFT JOIN "Volume" v ON i.volume_id = v.volume_id
      LEFT JOIN "Journal" j ON v.journal_id = j.journal_id
      WHERE COALESCE(a.is_deleted, false) = false AND ${whereClause}
      ORDER BY a.publication_year DESC NULLS LAST, a.created_at DESC
      LIMIT $${limitIndex} OFFSET $${offsetIndex}
    `;

    const dataRes = await client.query(dataQuery, params);

    // Format the items
    const items = dataRes.rows.map(row => ({
      id: row.id,
      title: row.title,
      description: row.description,
      publishedYear: row.publishedYear || row.publishedyear,
      isOpenAccess: row.isOpenAccess === true || row.isOpenAccess === 'true' || row.isopenaccess === true || row.isopenaccess === 'true' || row.is_open_access === true,
      authors: row.authors || 'Unknown Authors',
      keywords: row.keywords || '',
      doi: row.doi || null,
      isBookmarked: row.isBookmarked === true || row.isbookmarked === true
    }));

    return {
      total,
      totalPages,
      currentPage: page,
      items
    };

  } catch (error) {
    console.error('Error fetching curated articles:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Service to fetch keywords tracked by a given project.
 * @param {string|number} projectId
 * @returns {Promise<Array>}
 */
export async function getProjectKeywords(projectId) {
  const client = await pool.connect();
  try {
    const query = `
      SELECT k.keyword_id AS id, k.display_name AS label
      FROM "Project_Keyword" pk
      JOIN "Keyword" k ON pk.keyword_id = k.keyword_id
      WHERE pk.project_id = $1
    `;
    const res = await client.query(query, [projectId]);
    return res.rows;
  } catch (error) {
    console.error('Error fetching project keywords:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Service to add a keyword to a project's tracked keywords.
 * Creates the keyword if it doesn't exist.
 * @param {string|number} projectId
 * @param {string} keywordName
 * @returns {Promise<Object>}
 */
export async function addProjectKeyword(projectId, keywordName) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cleanName = keywordName.trim();
    // Check if keyword exists
    let keywordRes = await client.query('SELECT keyword_id FROM "Keyword" WHERE LOWER(display_name) = $1', [cleanName.toLowerCase()]);
    let keywordId;
    if (keywordRes.rows.length > 0) {
      keywordId = keywordRes.rows[0].keyword_id;
    } else {
      // Create it
      const insertRes = await client.query('INSERT INTO "Keyword" (display_name) VALUES ($1) RETURNING keyword_id', [cleanName]);
      keywordId = insertRes.rows[0].keyword_id;
    }
    
    // Check if already tracking
    const checkRes = await client.query('SELECT 1 FROM "Project_Keyword" WHERE project_id = $1 AND keyword_id = $2', [projectId, keywordId]);
    if (checkRes.rows.length === 0) {
      await client.query('INSERT INTO "Project_Keyword" (project_id, keyword_id) VALUES ($1, $2)', [projectId, keywordId]);
    }
    await client.query('COMMIT');
    return { id: keywordId, label: cleanName };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error adding project keyword:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Service to remove a keyword from a project's tracked keywords.
 * @param {string|number} projectId
 * @param {string|number} keywordId
 */
export async function removeProjectKeyword(projectId, keywordId) {
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM "Project_Keyword" WHERE project_id = $1 AND keyword_id = $2', [projectId, keywordId]);
  } catch (error) {
    console.error('Error removing project keyword:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Service to fetch journals associated with the curated articles of a project.
 * @param {string|number} projectId
 * @returns {Promise<Array>}
 */
export async function getTrackedJournals(projectId) {
  const client = await pool.connect();
  try {
    // 1. Resolve Project Scope (Same as curated articles)
    const projectRes = await client.query(
      `SELECT project_id, subject_area FROM "Project" WHERE project_id = $1`,
      [projectId]
    );
    if (projectRes.rows.length === 0) return [];
    
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

    if (scopeCategoryIds.length === 0 && scopeKeywordIds.length === 0) return [];

    const params = [];
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

    const whereClause = `(${scopeConditions.join(' OR ')})`;

    // 2. Fetch top 10 journals by SJR impact score for these articles
    const query = `
      WITH project_journals AS (
        SELECT DISTINCT j.journal_id, j.display_name AS name, j.issn
        FROM "Article" a
        JOIN "Issue" i ON a.issue_id = i.issue_id
        JOIN "Volume" v ON i.volume_id = v.volume_id
        JOIN "Journal" j ON v.journal_id = j.journal_id
        WHERE COALESCE(a.is_deleted, false) = false 
          AND ${whereClause}
      ),
      journal_sjr AS (
        SELECT
          jr.journal_id,
          jr.value_float AS sjr_score,
          rm.code,
          ROW_NUMBER() OVER (PARTITION BY jr.journal_id ORDER BY jr.year DESC) AS rn
        FROM "Journal_Ranking" jr
        JOIN "Ranking_Metric" rm ON jr.metric_id = rm.metric_id
        WHERE rm.code = 'SJR'
          AND jr.journal_id IN (SELECT journal_id FROM project_journals)
      ),
      journal_quartile AS (
        SELECT
          jr.journal_id,
          jr.value_txt AS quartile,
          ROW_NUMBER() OVER (PARTITION BY jr.journal_id ORDER BY jr.year DESC) AS rn
        FROM "Journal_Ranking" jr
        JOIN "Ranking_Metric" rm ON jr.metric_id = rm.metric_id
        WHERE rm.code = 'SJR_BEST_QUARTILE'
          AND jr.journal_id IN (SELECT journal_id FROM project_journals)
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

    return dataRes.rows.map(row => ({
      id: row.id,
      name: row.name,
      publisher: 'Unknown Publisher',
      issn: row.issn || 'N/A',
      impactFactor: row.impactFactor ? parseFloat(row.impactFactor) : 0,
      sjrRank: row.sjrRank || 'N/A',
      trend: [0, 1, 2, 1, 3, 2, 4], // Placeholder trend
      cover: `https://via.placeholder.com/48x64/f1f5f9/1a1a1a?text=${(row.name || 'JNL').substring(0, 3).toUpperCase()}`
    }));

  } catch (error) {
    console.error('Error fetching tracked journals:', error);
    throw error;
  } finally {
    client.release();
  }
}
