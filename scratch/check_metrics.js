import pool from '../src/config/database.js';

async function check() {
  try {
    const res = await pool.query(`
      SELECT code, display_name 
      FROM "Ranking_Metric" 
      ORDER BY code;
    `);
    console.log('Metrics in DB:', JSON.stringify(res.rows, null, 2));

    const jrRes = await pool.query(`
      SELECT jr.value_txt, COUNT(*) 
      FROM "Journal_Ranking" jr
      JOIN "Ranking_Metric" rm ON jr.metric_id = rm.metric_id
      WHERE rm.code = 'SJR_BEST_QUARTILE'
      GROUP BY jr.value_txt;
    `);
    console.log('SJR_BEST_QUARTILE counts:', JSON.stringify(jrRes.rows, null, 2));

    const totalJrRes = await pool.query(`
      SELECT rm.code, COUNT(*)
      FROM "Journal_Ranking" jr
      JOIN "Ranking_Metric" rm ON jr.metric_id = rm.metric_id
      GROUP BY rm.code;
    `);
    console.log('Total rankings by code:', JSON.stringify(totalJrRes.rows, null, 2));

  } catch (e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}
check();
