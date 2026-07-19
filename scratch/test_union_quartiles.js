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

    console.log('Categories count:', projectCategoryIds.length);
    console.log('Keywords count:', projectKeywordIds.length);

    // Let's write the query using UNION branches
    const querySql = `
      WITH project_articles AS (
        SELECT a.article_id, a.issue_id, a.publication_year, a.primary_topic
        FROM "Article" a
        JOIN "Topic" t ON a.primary_topic = t.topic_id
        WHERE t.subject_category_id = ANY($1::bigint[])
          AND COALESCE(a.is_deleted, false) = false
        UNION
        SELECT a.article_id, a.issue_id, a.publication_year, a.primary_topic
        FROM "Sub_Topic" st
        JOIN "Topic" t ON st.topic_id = t.topic_id
        JOIN "Article" a ON st.article_id = a.article_id
        WHERE t.subject_category_id = ANY($1::bigint[])
          AND COALESCE(a.is_deleted, false) = false
        UNION
        SELECT a.article_id, a.issue_id, a.publication_year, a.primary_topic
        FROM "Keyword_Article" ka
        JOIN "Article" a ON ka.article_id = a.article_id
        WHERE ka.keyword_id = ANY($2::bigint[])
          AND COALESCE(a.is_deleted, false) = false
      )
      SELECT 
        jr.value_txt AS "quartile",
        COUNT(DISTINCT a.article_id)::integer AS count
      FROM project_articles a
      JOIN "Issue" i ON a.issue_id = i.issue_id AND COALESCE(i.is_deleted, false) = false
      JOIN "Volume" v ON i.volume_id = v.volume_id AND COALESCE(v.is_deleted, false) = false
      JOIN "Journal" j ON v.journal_id = j.journal_id AND COALESCE(j.is_deleted, false) = false
      JOIN "Journal_Ranking" jr ON jr.journal_id = j.journal_id AND jr.value_txt IN ('Q1', 'Q2', 'Q3', 'Q4')
      JOIN "Ranking_Metric" rm ON jr.metric_id = rm.metric_id AND rm.code = 'SJR_BEST_QUARTILE'
      GROUP BY jr.value_txt;
    `;

    console.log('Running UNION CTE Query...');
    const start = Date.now();
    const res = await pool.query(querySql, [projectCategoryIds, projectKeywordIds]);
    console.log('Time:', Date.now() - start, 'ms');
    console.log('Rows:', JSON.stringify(res.rows, null, 2));

  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}
run();
