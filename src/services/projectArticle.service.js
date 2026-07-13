import pool from '../config/database.js';
import logger from '../utils/logger.js';

export const bookmarkArticle = async (projectId, articleId, userId, notes) => {
  const query = `
    INSERT INTO "Project_Article_Bookmark" (project_id, article_id, user_id, added_at)
    VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
    ON CONFLICT (project_id, article_id, user_id) 
    DO UPDATE SET added_at = EXCLUDED.added_at
    RETURNING *;
  `;
  const result = await pool.query(query, [projectId, articleId, userId]);
  return result.rows[0];
};

export const unbookmarkArticle = async (projectId, articleId, userId) => {
  const query = `
    DELETE FROM "Project_Article_Bookmark"
    WHERE project_id = $1 AND article_id = $2 AND user_id = $3
    RETURNING *;
  `;
  const result = await pool.query(query, [projectId, articleId, userId]);
  return result.rows[0];
};

export const updateBookmarkNotes = async (projectId, articleId, userId, notes) => {
  // notes column doesn't exist, so this is just a dummy return or we can return the existing record
  const query = `
    SELECT * FROM "Project_Article_Bookmark"
    WHERE project_id = $1 AND article_id = $2 AND user_id = $3
  `;
  const result = await pool.query(query, [projectId, articleId, userId]);
  return result.rows[0];
};

export const getBookmarkedArticles = async (projectId) => {
  const query = `
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
      pab.added_at
    FROM "Project_Article_Bookmark" pab
    JOIN "Article" a ON pab.article_id = a.article_id
    LEFT JOIN "Issue" i ON a.issue_id = i.issue_id
    LEFT JOIN "Volume" v ON i.volume_id = v.volume_id
    LEFT JOIN "Journal" j ON v.journal_id = j.journal_id
    WHERE pab.project_id = $1 AND COALESCE(a.is_deleted, false) = false
    ORDER BY pab.added_at DESC
  `;
  
  const result = await pool.query(query, [projectId]);
  return result.rows.map(row => ({
    id: row.id,
    title: row.title,
    description: row.description,
    publishedYear: row.publishedYear || row.publishedyear,
    isOpenAccess: row.isOpenAccess === true || row.isOpenAccess === 'true' || row.isopenaccess === true || row.isopenaccess === 'true' || row.is_open_access === true,
    isBookmarked: true,
    doi: row.doi || null,
    authors: row.authors || 'Unknown Authors',
    keywords: row.keywords || '',
    addedAt: row.added_at
  }));
};
