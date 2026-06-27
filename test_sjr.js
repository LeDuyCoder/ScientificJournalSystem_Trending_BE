import pool from './src/config/database.js';

async function run() {
  const client = await pool.connect();
  try {
    const res = await client.query(`
      SELECT jr.journal_id, jr.year, jr.value_float, jr.value_txt
      FROM "Journal_Ranking" jr
      JOIN "Ranking_Metric" rm ON rm.metric_id = jr.metric_id
      JOIN "Journal" j ON j.journal_id = jr.journal_id
      WHERE j.display_name = 'European Urology'
        AND rm.code = 'SJR'
      ORDER BY jr.year DESC
    `);
    console.table(res.rows);
  } catch (err) {
    console.error(err);
  } finally {
    client.release();
    process.exit(0);
  }
}
run();
