import pool from '../config/database.js';

/**
 * Retrieves the journal access models for a specific project scope and year range.
 * Uses COALESCE to fallback: Journal_Ranking.access_model -> Journal.access_model -> 'LEGACY_MODEL'.
 * 
 * @param {object} filter
 * @param {number[]} filter.projectCategoryIds
 * @param {number[]} filter.projectKeywordIds
 * @param {string|undefined} filter.subjectArea
 * @param {string[]} filter.keywordList
 * @param {number} filter.fromYear
 * @param {number} filter.toYear
 * @returns {Promise<Array>} List of journals with their source (fromYear) and target (toYear) access models.
 */
export async function findJournalMigrationSnapshots(filter) {
  const {
    projectCategoryIds,
    projectKeywordIds,
    subjectArea,
    keywordList,
    fromYear,
    toYear
  } = filter;

  let params = [];
  let sqlFilters = [];

  // 1. Filter by Project Scope
  if (projectCategoryIds.length > 0 || projectKeywordIds.length > 0) {
    let applyCategories = projectCategoryIds.length > 0;
    let applyKeywords = projectKeywordIds.length > 0;

    if (subjectArea && keywordList.length === 0) {
      applyKeywords = false;
    } else if (keywordList.length > 0 && !subjectArea) {
      applyCategories = false;
    }

    const scopeConditions = [];
    if (applyCategories && projectCategoryIds.length > 0) {
      params.push(projectCategoryIds);
      const idx = params.length;
      scopeConditions.push(`
        (
          EXISTS (
            SELECT 1 FROM "Topic" t
            WHERE t.topic_id = a.primary_topic
              AND t.subject_category_id = ANY($${idx}::bigint[])
          )
          OR EXISTS (
            SELECT 1 FROM "Sub_Topic" st
            JOIN "Topic" st_topic ON st.topic_id = st_topic.topic_id
            WHERE st.article_id = a.article_id
              AND st_topic.subject_category_id = ANY($${idx}::bigint[])
          )
        )
      `);
    }

    if (applyKeywords && projectKeywordIds.length > 0) {
      params.push(projectKeywordIds);
      const idx = params.length;
      scopeConditions.push(`
        EXISTS (
          SELECT 1 FROM "Keyword_Article" ka
          WHERE ka.article_id = a.article_id
            AND ka.keyword_id = ANY($${idx}::bigint[])
        )
      `);
    }

    if (scopeConditions.length > 0) {
      sqlFilters.push(`(${scopeConditions.join(' OR ')})`);
    } else {
      return []; // Return empty if criteria excludes everything
    }
  }

  // 2. Client Filter: subject_area
  if (subjectArea) {
    const saRes = await pool.query(
      `SELECT subject_category_id FROM "Subject_Category" 
       WHERE subject_area_id = (SELECT subject_area_id FROM "Subject_Area" WHERE LOWER(display_name) = LOWER($1) AND COALESCE(is_deleted, false) = false LIMIT 1)
       AND COALESCE(is_deleted, false) = false`,
      [subjectArea.trim()]
    );
    const filterCatIds = saRes.rows.map(r => Number(r.subject_category_id));
    if (filterCatIds.length === 0) return [];

    params.push(filterCatIds);
    const idx = params.length;
    sqlFilters.push(`
      (
        EXISTS (
          SELECT 1 FROM "Topic" ft
          WHERE ft.topic_id = a.primary_topic
            AND ft.subject_category_id = ANY($${idx}::bigint[])
        )
        OR EXISTS (
          SELECT 1 FROM "Sub_Topic" fst
          JOIN "Topic" fst_topic ON fst.topic_id = fst_topic.topic_id
          WHERE fst.article_id = a.article_id
            AND fst_topic.subject_category_id = ANY($${idx}::bigint[])
        )
      )
    `);
  }

  // 3. Client Filter: keywords
  if (keywordList && keywordList.length > 0) {
    const kwRes = await pool.query(
      `SELECT keyword_id FROM "Keyword" WHERE LOWER(display_name) = ANY($1::text[])`,
      [keywordList.map(k => k.toLowerCase())]
    );
    const filterKwIds = kwRes.rows.map(r => Number(r.keyword_id));
    if (filterKwIds.length === 0) return [];

    params.push(filterKwIds);
    const idx = params.length;
    sqlFilters.push(`
      EXISTS (
        SELECT 1 FROM "Keyword_Article" fka
        WHERE fka.article_id = a.article_id
          AND fka.keyword_id = ANY($${idx}::bigint[])
      )
    `);
  }

  const whereClause = sqlFilters.length > 0 ? `AND ${sqlFilters.join(' AND ')}` : '';

  const querySql = `
    WITH FilteredArticles AS (
      SELECT a.article_id
      FROM "Article" a
      WHERE COALESCE(a.is_deleted, false) = false
      ${whereClause}
    ),
    FilteredJournals AS (
      SELECT DISTINCT v.journal_id
      FROM FilteredArticles fa
      JOIN "Article" a ON fa.article_id = a.article_id
      JOIN "Issue" a_issue ON a.issue_id = a_issue.issue_id
      JOIN "Volume" v ON a_issue.volume_id = v.volume_id
    )
    SELECT 
      fj.journal_id,
      'SUBSCRIPTION' AS source_access_model,
      CASE 
        WHEN j.is_open_access = true THEN 'FULL_OPEN_ACCESS' 
        ELSE 'LEGACY_MODEL' 
      END AS target_access_model
    FROM FilteredJournals fj
    JOIN "Journal" j ON fj.journal_id = j.journal_id
    WHERE COALESCE(j.is_deleted, false) = false;
  `;

  const result = await pool.query(querySql, params);
  return result.rows;
}
