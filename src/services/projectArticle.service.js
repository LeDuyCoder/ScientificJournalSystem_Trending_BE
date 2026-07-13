import pool from '../config/database.js';
import logger from '../utils/logger.js';

export const bookmarkArticle = async (projectId, articleId, userId, notes) => {
  const query = `
    INSERT INTO "Project_Article_Bookmark" (project_id, article_id, user_id, notes, added_at)
    VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
    ON CONFLICT (project_id, article_id, user_id) 
    DO UPDATE SET notes = EXCLUDED.notes, added_at = EXCLUDED.added_at
    RETURNING *;
  `;
  const result = await pool.query(query, [projectId, articleId, userId, notes || null]);
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
  const query = `
    UPDATE "Project_Article_Bookmark"
    SET notes = $4
    WHERE project_id = $1 AND article_id = $2 AND user_id = $3
    RETURNING *;
  `;
  const result = await pool.query(query, [projectId, articleId, userId, notes]);
  return result.rows[0];
};

export const getBookmarkedArticles = async (projectId) => {
  const query = `
    SELECT 
      a.article_id AS "id",
      a.title,
      a.publication_year AS "publishedYear",
      a.doi,
      a.abstract,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'user_id', u.user_id,
            'first_name', u.first_name,
            'last_name', u.last_name,
            'url_image', u.url_image,
            'notes', pab.notes,
            'added_at', pab.added_at
          )
        ) FILTER (WHERE u.user_id IS NOT NULL), 
        '[]'::jsonb
      ) AS bookmarks
    FROM "Project_Article_Bookmark" pab
    JOIN "Article" a ON pab.article_id = a.article_id
    JOIN "user" u ON pab.user_id = u.user_id
    WHERE pab.project_id = $1 AND COALESCE(a.is_deleted, false) = false
    GROUP BY a.article_id, a.title, a.publication_year, a.doi, a.abstract
    ORDER BY MAX(pab.added_at) DESC
  `;
  
  const result = await pool.query(query, [projectId]);
  return result.rows;
};
