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

    // Let's count how many articles match the primary topics:
    const start1 = Date.now();
    const primaryRes = await pool.query(`
      SELECT COUNT(*) FROM "Article" a
      JOIN "Topic" t ON a.primary_topic = t.topic_id
      WHERE t.subject_category_id = ANY($1::bigint[])
        AND COALESCE(a.is_deleted, false) = false;
    `, [projectCategoryIds]);
    console.log('Primary topic articles:', primaryRes.rows[0].count, 'Time:', Date.now() - start1, 'ms');

    // Let's count how many articles match the sub topics:
    const start2 = Date.now();
    const subRes = await pool.query(`
      SELECT COUNT(*) FROM "Sub_Topic" st
      JOIN "Topic" t ON st.topic_id = t.topic_id
      JOIN "Article" a ON st.article_id = a.article_id
      WHERE t.subject_category_id = ANY($1::bigint[])
        AND COALESCE(a.is_deleted, false) = false;
    `, [projectCategoryIds]);
    console.log('Sub topic articles:', subRes.rows[0].count, 'Time:', Date.now() - start2, 'ms');

  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}
run();
