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

    console.log('Categories count:', projectCategoryIds.length);

    // Let's count how many primary topic articles have non-null issue_id:
    const res1 = await pool.query(`
      SELECT COUNT(*) FROM "Article" a
      JOIN "Topic" t ON a.primary_topic = t.topic_id
      WHERE t.subject_category_id = ANY($1::bigint[])
        AND COALESCE(a.is_deleted, false) = false
        AND a.issue_id IS NOT NULL;
    `, [projectCategoryIds]);
    console.log('Articles with non-null issue_id:', res1.rows[0].count);

    // Let's count how many successfully join to Issue:
    const res2 = await pool.query(`
      SELECT COUNT(*) FROM "Article" a
      JOIN "Topic" t ON a.primary_topic = t.topic_id
      JOIN "Issue" i ON a.issue_id = i.issue_id
      WHERE t.subject_category_id = ANY($1::bigint[])
        AND COALESCE(a.is_deleted, false) = false;
    `, [projectCategoryIds]);
    console.log('Articles joining to Issue:', res2.rows[0].count);

    // Let's count how many join to Volume:
    const res3 = await pool.query(`
      SELECT COUNT(*) FROM "Article" a
      JOIN "Topic" t ON a.primary_topic = t.topic_id
      JOIN "Issue" i ON a.issue_id = i.issue_id
      JOIN "Volume" v ON i.volume_id = v.volume_id
      WHERE t.subject_category_id = ANY($1::bigint[])
        AND COALESCE(a.is_deleted, false) = false;
    `, [projectCategoryIds]);
    console.log('Articles joining to Volume:', res3.rows[0].count);

    // Let's count how many join to Journal:
    const res4 = await pool.query(`
      SELECT COUNT(*) FROM "Article" a
      JOIN "Topic" t ON a.primary_topic = t.topic_id
      JOIN "Issue" i ON a.issue_id = i.issue_id
      JOIN "Volume" v ON i.volume_id = v.volume_id
      JOIN "Journal" j ON v.journal_id = j.journal_id
      WHERE t.subject_category_id = ANY($1::bigint[])
        AND COALESCE(a.is_deleted, false) = false;
    `, [projectCategoryIds]);
    console.log('Articles joining to Journal:', res4.rows[0].count);

    // Let's count how many join to Journal_Ranking and Ranking_Metric:
    const res5 = await pool.query(`
      SELECT COUNT(*) FROM "Article" a
      JOIN "Topic" t ON a.primary_topic = t.topic_id
      JOIN "Issue" i ON a.issue_id = i.issue_id
      JOIN "Volume" v ON i.volume_id = v.volume_id
      JOIN "Journal" j ON v.journal_id = j.journal_id
      JOIN "Journal_Ranking" jr ON jr.journal_id = j.journal_id
      JOIN "Ranking_Metric" rm ON jr.metric_id = rm.metric_id AND rm.code = 'SJR_BEST_QUARTILE'
      WHERE t.subject_category_id = ANY($1::bigint[])
        AND COALESCE(a.is_deleted, false) = false;
    `, [projectCategoryIds]);
    console.log('Articles joining to Journal_Ranking:', res5.rows[0].count);

  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}
run();
