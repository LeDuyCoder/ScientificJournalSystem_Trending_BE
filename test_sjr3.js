import pool from './src/config/database.js';

async function run() {
  const client = await pool.connect();
  const res = await client.query(`
    SELECT year, COUNT(value_txt) AS non_null_txt, COUNT(value_float) AS non_null_float
    FROM "Journal_Ranking" jr
    JOIN "Ranking_Metric" rm ON rm.metric_id = jr.metric_id
    WHERE rm.code = 'SJR'
    GROUP BY year ORDER BY year DESC;
  `);
  console.table(res.rows);
  client.release();
  process.exit(0);
}
run();
