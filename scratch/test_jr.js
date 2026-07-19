import pool from '../src/config/database.js';

async function run() {
  try {
    const res = await pool.query(`
      SELECT jr.value_txt, COUNT(*)
      FROM "Journal_Ranking" jr
      JOIN "Ranking_Metric" rm ON jr.metric_id = rm.metric_id
      WHERE rm.code = 'SJR_BEST_QUARTILE'
      GROUP BY jr.value_txt;
    `);
    console.log(res.rows);
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}
run();
