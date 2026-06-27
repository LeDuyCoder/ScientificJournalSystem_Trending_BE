import pool from './src/config/database.js';
async function run() {
  const client = await pool.connect();
  const res = await client.query(`
    SELECT year, COUNT(*)
    FROM "Journal_Ranking" jr
    JOIN "Ranking_Metric" rm ON rm.metric_id = jr.metric_id
    WHERE rm.code = 'SJR' AND value_float IS NULL
    GROUP BY year ORDER BY year DESC;
  `);
  console.log("NULL values by year:", res.rows);

  const res2 = await client.query(`
    SELECT year, COUNT(*)
    FROM "Journal_Ranking" jr
    JOIN "Ranking_Metric" rm ON rm.metric_id = jr.metric_id
    WHERE rm.code = 'SJR'
    GROUP BY year ORDER BY year DESC;
  `);
  console.log("Total values by year:", res2.rows);

  client.release();
  process.exit(0);
}
run();
