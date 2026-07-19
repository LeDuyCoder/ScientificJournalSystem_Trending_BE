import pool from '../config/database.js';
import logger from '../utils/logger.js';
import { fetchWithCache } from './analytics/cache.service.js';
import { getResolvedScope } from './analytics/scope.repository.js';
import { normalizeSourceModel, normalizeTargetModel, buildInitialMigrationFlow, calculateTransitionRate } from '../utils/accessModel.js';

const CACHE_KEY_PREFIX = 'analytics:journal-migration:v2';
const CACHE_TTL = 43200; // 12 hours

export async function getJournalMigrationAnalysis(query) {
  let { project_id, subject_area, keywords, from_year, to_year, include_legacy } = query;

  from_year = from_year || 2024;
  to_year = to_year || 2026;

  const queryParams = {
    project_id,
    domain: subject_area,
    subject_category: keywords
  };

  const scope = await getResolvedScope(queryParams);

  const cacheKey = `${CACHE_KEY_PREFIX}:${scope.resolvedProjectId || 'all'}:${scope.mappedDomain}:${scope.projectCategoryIds.join(',')}:${from_year}:${to_year}:${include_legacy || false}`;

  return fetchWithCache(cacheKey, CACHE_TTL, async () => {
    try {
      let params = [];
      let articleFilter = '';

      if (scope.hasProject && scope.projectCategoryIds.length > 0) {
        articleFilter = `
          WITH target_topics AS (
            SELECT topic_id FROM "Topic" WHERE subject_category_id = ANY($${params.length + 1}::bigint[])
          ),
          project_articles_issues AS (
            SELECT issue_id, article_id
            FROM "Article" a
            WHERE primary_topic IN (SELECT topic_id FROM target_topics)
              AND coalesce(is_deleted, false) = false
            UNION
            SELECT a.issue_id, a.article_id
            FROM "Sub_Topic" st
            JOIN "Article" a ON st.article_id = a.article_id
            WHERE st.topic_id IN (SELECT topic_id FROM target_topics)
              AND coalesce(a.is_deleted, false) = false
          ),
          issue_counts AS (
            SELECT issue_id, COUNT(DISTINCT article_id) AS cnt
            FROM project_articles_issues
            GROUP BY issue_id
          ),
          distinct_journals AS (
            SELECT DISTINCT v.journal_id
            FROM issue_counts ic
            JOIN "Issue" i ON ic.issue_id = i.issue_id
            JOIN "Volume" v ON i.volume_id = v.volume_id
          )
        `;
        params.push(scope.projectCategoryIds);
      } else if (scope.mappedDomain && scope.mappedDomain !== 'all') {
        articleFilter = `
          WITH target_topics AS (
            SELECT t.topic_id FROM "Topic" t
            JOIN "Subject_Category" sc ON t.subject_category_id = sc.subject_category_id
            JOIN "Subject_Area" sa ON sc.subject_area_id = sa.subject_area_id
            WHERE LOWER(sa.display_name) = LOWER($${params.length + 1})
          ),
          project_articles_issues AS (
            SELECT issue_id, article_id
            FROM "Article" a
            WHERE primary_topic IN (SELECT topic_id FROM target_topics)
              AND coalesce(is_deleted, false) = false
            UNION
            SELECT a.issue_id, a.article_id
            FROM "Sub_Topic" st
            JOIN "Article" a ON st.article_id = a.article_id
            WHERE st.topic_id IN (SELECT topic_id FROM target_topics)
              AND coalesce(a.is_deleted, false) = false
          ),
          issue_counts AS (
            SELECT issue_id, COUNT(DISTINCT article_id) AS cnt
            FROM project_articles_issues
            GROUP BY issue_id
          ),
          distinct_journals AS (
            SELECT DISTINCT v.journal_id
            FROM issue_counts ic
            JOIN "Issue" i ON ic.issue_id = i.issue_id
            JOIN "Volume" v ON i.volume_id = v.volume_id
          )
        `;
        params.push(scope.mappedDomain);
      } else {
        articleFilter = `
          WITH issue_counts AS (
            SELECT issue_id, COUNT(article_id) AS cnt
            FROM "Article" a
            WHERE coalesce(a.is_deleted, false) = false
            GROUP BY issue_id
          ),
          distinct_journals AS (
            SELECT DISTINCT v.journal_id
            FROM issue_counts ic
            JOIN "Issue" i ON ic.issue_id = i.issue_id
            JOIN "Volume" v ON i.volume_id = v.volume_id
          )
        `;
      }

      const sql = `
        ${articleFilter}
        SELECT 
          dj.journal_id,
          'SUBSCRIPTION' AS source_access_model,
          CASE 
            WHEN j.is_open_access = true THEN 'FULL_OPEN_ACCESS' 
            ELSE 'LEGACY_MODEL' 
          END AS target_access_model
        FROM distinct_journals dj
        JOIN "Journal" j ON dj.journal_id = j.journal_id
        WHERE COALESCE(j.is_deleted, false) = false
      `;

      const result = await pool.query(sql, params);
      const snapshots = result.rows;

      const flowsMap = buildInitialMigrationFlow();
      let totalCount = 0;

      for (const row of snapshots) {
        const source = normalizeSourceModel(row.source_access_model);
        if (source === "FULL_OPEN_ACCESS") continue;

        const target = normalizeTargetModel(row.target_access_model);
        const key = `${source}->${target}`;
        
        if (flowsMap.has(key)) {
          flowsMap.set(key, flowsMap.get(key) + 1);
        } else {
          flowsMap.set(key, 1);
        }
        totalCount++;
      }

      let flows = [];
      let openAccessCount = 0;

      for (const [key, value] of flowsMap.entries()) {
        const [source, target] = key.split('->');
        const isLegacy = (include_legacy === 'false' || include_legacy === false) && target !== 'FULL_OPEN_ACCESS';
        
        if (!isLegacy) {
          flows.push({ source, target, value });
          if (target === 'FULL_OPEN_ACCESS') {
            openAccessCount += value;
          }
        }
      }

      totalCount = flows.reduce((sum, flow) => sum + flow.value, 0);
      const transitionRate = calculateTransitionRate(openAccessCount, totalCount);

      return {
        totalCount,
        transitionRate,
        flows
      };

    } catch (error) {
      logger.error('Error fetching journal migration data:', error);
      if (error.status) throw error;
      throw new Error('Internal server error while fetching journal migration data');
    }
  });
}
