import pool from '../src/config/database.js';

async function run() {
  try {
    const projectRes = await pool.query(
      `SELECT project_id, subject_area FROM "Project" WHERE project_id = 12`
    );
    const project = projectRes.rows[0];

    const categoriesRes = await pool.query(
      `SELECT subject_category_id FROM "Subject_Category" WHERE subject_area_id = $1 AND COALESCE(is_deleted, false) = false`,
      [project.subject_area]
    );
    const projectCategoryIds = categoriesRes.rows.map(r => Number(r.subject_category_id));

    const keywordsRes = await pool.query(
      `SELECT keyword_id FROM "Project_Keyword" WHERE project_id = 12`
    );
    const projectKeywordIds = keywordsRes.rows.map(r => Number(r.keyword_id));

    console.log('Categories:', projectCategoryIds.length);
    console.log('Keywords:', projectKeywordIds.length);

    // Build scope conditions
    const scopeConditions = [];
    const params = [];

    if (projectCategoryIds.length > 0) {
      params.push(projectCategoryIds);
      const catIdx = params.length;
      scopeConditions.push(`
        (
          EXISTS (
            SELECT 1 FROM "Topic" primary_topic
            WHERE primary_topic.topic_id = a.primary_topic
              AND primary_topic.subject_category_id = ANY($${catIdx}::bigint[])
          )
          OR EXISTS (
            SELECT 1 FROM "Sub_Topic" st
            JOIN "Topic" sub_topic ON st.topic_id = sub_topic.topic_id
            WHERE st.article_id = a.article_id
              AND sub_topic.subject_category_id = ANY($${catIdx}::bigint[])
          )
        )
      `);
    }

    if (projectKeywordIds.length > 0) {
      params.push(projectKeywordIds);
      const kwIdx = params.length;
      scopeConditions.push(`
        EXISTS (
          SELECT 1 FROM "Keyword_Article" ka
          WHERE ka.article_id = a.article_id
            AND ka.keyword_id = ANY($${kwIdx}::bigint[])
        )
      `);
    }

    const scopeFilter = scopeConditions.length > 0 ? `(${scopeConditions.join(' OR ')})` : 'FALSE';

    const optimizedQuery = `
      WITH project_articles AS (
        SELECT a.article_id, a.issue_id
        FROM "Article" a
        WHERE COALESCE(a.is_deleted, false) = false
          AND ${scopeFilter}
      )
      SELECT 
        jr.value_txt AS "quartile",
        COUNT(DISTINCT pa.article_id)::integer AS count
      FROM project_articles pa
      JOIN "Issue" i ON pa.issue_id = i.issue_id AND COALESCE(i.is_deleted, false) = false
      JOIN "Volume" v ON i.volume_id = v.volume_id AND COALESCE(v.is_deleted, false) = false
      JOIN "Journal" j ON v.journal_id = j.journal_id AND COALESCE(j.is_deleted, false) = false
      JOIN "Journal_Ranking" jr ON jr.journal_id = j.journal_id AND jr.value_txt IN ('Q1', 'Q2', 'Q3', 'Q4')
      JOIN "Ranking_Metric" rm ON jr.metric_id = rm.metric_id AND rm.code = 'SJR_BEST_QUARTILE'
      GROUP BY jr.value_txt;
    `;

    console.log('Running Optimized CTE Query...');
    const start = Date.now();
    const res = await pool.query(optimizedQuery, params);
    console.log('Time:', Date.now() - start, 'ms');
    console.log('Rows:', JSON.stringify(res.rows, null, 2));

  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}
run();
