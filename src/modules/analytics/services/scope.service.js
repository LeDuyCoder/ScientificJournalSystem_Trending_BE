import pool from '../../../config/database.js';
import logger from '../../../utils/logger.js';
import { redisGet, redisSet } from '../../core/services/infrastructure/redis.service.js';

const SCOPE_ENSURED_TTL = 300; // 5 minutes

/**
 * Ensures that Project_Article_Scope has been populated for the given project.
 * If no articles exist in scope for this project, it gathers all subject categories
 * (from the project's subject_area and Subject_Category_Project) and keywords
 * (from Project_Keyword) and populates Project_Article_Scope on-demand.
 *
 * @param {string|number} projectId
 * @param {import('pg').PoolClient|null} dbClient
 */
export async function ensureProjectScope(projectId, dbClient = null) {
  if (!projectId || projectId === 'default-id') return;
  const numId = Number(projectId);
  if (isNaN(numId) || numId <= 0) return;

  const cacheKey = `analytics:scope:ensured:${numId}`;
  try {
    const isEnsured = await redisGet(cacheKey);
    if (isEnsured) return;
  } catch (err) {
    // Redis might be unavailable, continue with DB check
  }

  const client = dbClient || pool;

  try {
    // 1. Check if scope already has records
    const checkRes = await client.query(
      'SELECT 1 FROM "Project_Article_Scope" WHERE project_id = $1 LIMIT 1',
      [numId]
    );

    if (checkRes.rows.length > 0) {
      try {
        await redisSet(cacheKey, 'true', SCOPE_ENSURED_TTL);
      } catch (e) {}
      return;
    }

    // 2. Fetch project details
    const projRes = await client.query(
      'SELECT project_id, subject_area FROM "Project" WHERE project_id = $1',
      [numId]
    );
    if (projRes.rows.length === 0) return;
    const project = projRes.rows[0];

    // 3. Gather category IDs from subject_area and Subject_Category_Project
    let catIds = [];
    if (project.subject_area) {
      const saCats = await client.query(
        'SELECT subject_category_id FROM "Subject_Category" WHERE subject_area_id = $1 AND COALESCE(is_deleted, false) = false',
        [project.subject_area]
      );
      catIds.push(...saCats.rows.map(r => r.subject_category_id));
    }

    const explicitCats = await client.query(
      'SELECT subject_category_id FROM "Subject_Category_Project" WHERE project_id = $1',
      [numId]
    );
    catIds.push(...explicitCats.rows.map(r => r.subject_category_id));
    catIds = [...new Set(catIds.map(id => String(id)))];

    if (catIds.length > 0) {
      await client.query(`
        INSERT INTO "Project_Article_Scope" (project_id, article_id, publication_year)
        SELECT DISTINCT $1::bigint, a.article_id, a.publication_year
        FROM "Article" a
        WHERE a.primary_topic IN (
          SELECT topic_id FROM "Topic" WHERE subject_category_id = ANY($2::bigint[])
        )
        ON CONFLICT DO NOTHING
      `, [numId, catIds]);

      await client.query(`
        INSERT INTO "Project_Article_Scope" (project_id, article_id, publication_year)
        SELECT DISTINCT $1::bigint, a.article_id, a.publication_year
        FROM "Sub_Topic" st
        JOIN "Topic" sub_topic ON st.topic_id = sub_topic.topic_id
        JOIN "Article" a ON st.article_id = a.article_id
        WHERE sub_topic.subject_category_id = ANY($2::bigint[])
        ON CONFLICT DO NOTHING
      `, [numId, catIds]);
    }

    // 4. Gather keywords from Project_Keyword
    const kwsRes = await client.query(
      'SELECT keyword_id FROM "Project_Keyword" WHERE project_id = $1',
      [numId]
    );
    const kwIds = [...new Set(kwsRes.rows.map(r => String(r.keyword_id)))];

    if (kwIds.length > 0) {
      await client.query(`
        INSERT INTO "Project_Article_Scope" (project_id, article_id, publication_year)
        SELECT DISTINCT $1::bigint, a.article_id, a.publication_year
        FROM "Keyword_Article" ka
        JOIN "Article" a ON ka.article_id = a.article_id
        WHERE ka.keyword_id = ANY($2::bigint[])
        ON CONFLICT DO NOTHING
      `, [numId, kwIds]);
    }

    const countRes = await client.query(
      'SELECT COUNT(*) FROM "Project_Article_Scope" WHERE project_id = $1',
      [numId]
    );
    logger.info(`[Scope Service] Ensured Project_Article_Scope for project ${numId}: ${countRes.rows[0].count} articles`);

    try {
      await redisSet(cacheKey, 'true', SCOPE_ENSURED_TTL);
    } catch (e) {}
  } catch (error) {
    logger.error(`[Scope Service] Error ensuring scope for project ${numId}:`, error);
  }
}
