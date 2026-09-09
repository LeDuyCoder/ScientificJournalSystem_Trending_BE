import pool from '../../../../config/database.js';
import { fetchWithCache } from './cache.service.js';
import { getProjectScope } from '../trends/forecast.service.js';
import logger from '../../../../utils/logger.js';

/**
 * Scope Repository
 * Resolves project scope into target keywords and subject categories.
 * Heavily cached.
 */

const SCOPE_TTL = 300; // 5 minutes

export async function getResolvedScope(query) {
  const { project_id, domain, subject_category } = query;

  const cacheKey = `analytics:scope:v2:${project_id || 'all'}:${String(domain || 'all').toLowerCase()}:${String(subject_category || 'all').toLowerCase()}`;

  return fetchWithCache(cacheKey, SCOPE_TTL, async () => {
    let resolvedProjectId = null;
    let mappedDomain = 'all';
    let topicNames = [];
    let projectCategoryIds = [];
    let keywordIds = [];
    let keywordNames = [];

    const isFilterCategoryActive = subject_category && 
      String(subject_category).trim().toLowerCase() !== 'all' && 
      String(subject_category).trim().toLowerCase() !== 'all categories' &&
      String(subject_category).trim().toLowerCase() !== 'all domains';

    const hasProject = !!(project_id && project_id !== 'undefined' && project_id !== 'null');

    const client = await pool.connect();
    try {
      if (hasProject) {
        resolvedProjectId = project_id;
        const scope = await getProjectScope(client, project_id);
        mappedDomain = scope.subjectAreaName;

        if (isFilterCategoryActive) {
          const catRes = await client.query(
            `SELECT subject_category_id, display_name 
             FROM "Subject_Category" 
             WHERE (LOWER(display_name) = LOWER($1) OR subject_category_id::text = $1)
               AND subject_area_id = $2
               AND COALESCE(is_deleted, false) = false`,
            [subject_category.trim(), scope.subjectAreaId]
          );
          if (catRes.rows.length > 0) {
            const cat = catRes.rows[0];
            projectCategoryIds = [Number(cat.subject_category_id)];

            const topicsRes = await client.query(
              `SELECT display_name FROM "Topic" WHERE subject_category_id = $1`,
              [cat.subject_category_id]
            );
            topicNames = topicsRes.rows.map(r => r.display_name);
          }
        } else {
          topicNames = scope.keywordNames;
          projectCategoryIds = scope.subjectCategoryIds;
          keywordIds = scope.keywordIds || [];
          keywordNames = scope.keywordNames || [];
        }
      } else {
        // Global
        const d = String(domain || '').trim().toLowerCase();
        if (d && d !== 'all' && d !== 'all domains') {
          const saRes = await client.query(
            `SELECT display_name FROM "Subject_Area" WHERE LOWER(display_name) ILIKE $1 AND COALESCE(is_deleted, false) = false LIMIT 1`,
            [`%${d}%`]
          );
          if (saRes.rows.length > 0) mappedDomain = saRes.rows[0].display_name;
        }

        if (isFilterCategoryActive) {
          const catRes = await client.query(
            `SELECT subject_category_id, subject_area_id, display_name 
             FROM "Subject_Category" 
             WHERE (LOWER(display_name) = LOWER($1) OR subject_category_id::text = $1)
               AND COALESCE(is_deleted, false) = false`,
            [subject_category.trim()]
          );
          if (catRes.rows.length > 0) {
            const cat = catRes.rows[0];
            projectCategoryIds = [Number(cat.subject_category_id)];

            const saRes = await client.query(
              `SELECT display_name FROM "Subject_Area" WHERE subject_area_id = $1`,
              [cat.subject_area_id]
            );
            if (saRes.rows.length > 0) mappedDomain = saRes.rows[0].display_name;

            const topicsRes = await client.query(
              `SELECT display_name FROM "Topic" WHERE subject_category_id = $1`,
              [cat.subject_category_id]
            );
            topicNames = topicsRes.rows.map(r => r.display_name);
          }
        } else if (mappedDomain !== 'all') {
          const catsRes = await client.query(
            `SELECT subject_category_id FROM "Subject_Category" sc
             JOIN "Subject_Area" sa ON sc.subject_area_id = sa.subject_area_id
             WHERE LOWER(sa.display_name) = LOWER($1) AND COALESCE(sc.is_deleted, false) = false`,
            [mappedDomain]
          );
          projectCategoryIds = catsRes.rows.map(r => Number(r.subject_category_id));

          const topicsRes = await client.query(
            `SELECT DISTINCT t.display_name
             FROM "Topic" t
             JOIN "Subject_Category" sc ON t.subject_category_id = sc.subject_category_id
             JOIN "Subject_Area" sa ON sc.subject_area_id = sa.subject_area_id
             WHERE LOWER(sa.display_name) = LOWER($1)`,
            [mappedDomain]
          );
          topicNames = topicsRes.rows.map(r => r.display_name);
        }
      }
    } catch (err) {
      logger.error('Error resolving scope:', err);
    } finally {
      client.release();
    }

    // Optimization: Materialize target articles early if possible. 
    // We will do this via a shared SQL string or array if needed, but for now we return the parsed lists.
    
    return {
      hasProject,
      resolvedProjectId,
      mappedDomain,
      topicNames,
      projectCategoryIds,
      keywordIds,
      keywordNames
    };
  });
}
