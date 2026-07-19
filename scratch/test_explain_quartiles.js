import pool from '../src/config/database.js';

async function run() {
  // Let's manually reconstruct the query with project 12 scope categories & keywords
  // Project 12 details:
  // Subject area: 'Computer Science' or similar.
  // We can fetch the project categories and keywords first.

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

    const params = [projectCategoryIds];
    const whereClause = `
      AND (
        (
          EXISTS (
            SELECT 1 FROM "Topic" primary_topic
            WHERE primary_topic.topic_id = a.primary_topic
              AND primary_topic.subject_category_id = ANY($1::bigint[])
          )
          OR EXISTS (
            SELECT 1 FROM "Sub_Topic" st
            JOIN "Topic" sub_topic ON st.topic_id = sub_topic.topic_id
            WHERE st.article_id = a.article_id
              AND sub_topic.subject_category_id = ANY($1::bigint[])
          )
        )
      )
    `;

    const querySql = `
      EXPLAIN ANALYZE
      SELECT 
        jr.value_txt AS "quartile",
        COUNT(DISTINCT a.article_id)::integer AS count
      FROM "Article" a
      JOIN "Issue" i ON a.issue_id = i.issue_id AND COALESCE(i.is_deleted, false) = false
      JOIN "Volume" v ON i.volume_id = v.volume_id AND COALESCE(v.is_deleted, false) = false
      JOIN "Journal" j ON v.journal_id = j.journal_id AND COALESCE(j.is_deleted, false) = false
      JOIN "Journal_Ranking" jr ON jr.journal_id = j.journal_id AND jr.value_txt IN ('Q1', 'Q2', 'Q3', 'Q4')
      JOIN "Ranking_Metric" rm ON jr.metric_id = rm.metric_id AND rm.code = 'SJR_BEST_QUARTILE'
      WHERE COALESCE(a.is_deleted, false) = false
        ${whereClause}
      GROUP BY jr.value_txt
    `;

    console.log('Running EXPLAIN...');
    const res = await pool.query(querySql, params);
    for (const r of res.rows) {
      console.log(r['QUERY PLAN']);
    }
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}
run();
