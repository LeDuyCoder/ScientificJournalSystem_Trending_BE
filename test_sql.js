import pool from './src/config/database.js';

async function run() {
  const client = await pool.connect();
  const sql = `
      WITH project_articles AS (
        SELECT a.article_id, j.journal_id, j.display_name AS journal_name
        FROM "Article" a
        JOIN "Issue" i ON a.issue_id = i.issue_id
        JOIN "Volume" v ON i.volume_id = v.volume_id
        JOIN "Journal" j ON v.journal_id = j.journal_id
        WHERE COALESCE(a.is_deleted, false) = false
          AND COALESCE(j.is_deleted, false) = false
          -- skipping article filters for simplicity, just pick European Urology
          AND j.display_name = 'European Urology'
      ),
      journal_stats AS (
        SELECT 
          journal_id, 
          MAX(journal_name) AS journal_name, 
          COUNT(DISTINCT article_id) AS article_count
        FROM project_articles
        GROUP BY journal_id
      ),
      journal_metrics_raw AS (
        SELECT 
          jr.journal_id,
          jr.value_float,
          ROW_NUMBER() OVER(PARTITION BY jr.journal_id ORDER BY jr.year DESC) as rn
        FROM "Journal_Ranking" jr
        JOIN "Ranking_Metric" rm ON rm.metric_id = jr.metric_id
        WHERE jr.journal_id IN (SELECT journal_id FROM journal_stats)
          AND rm.code = 'SJR'
          -- no year filter
      ),
      journal_metrics AS (
        SELECT 
          journal_id,
          MAX(value_float) AS impact_factor
        FROM journal_metrics_raw
        WHERE rn = 1
        GROUP BY journal_id
      )
      SELECT 
        js.journal_name AS name,
        COALESCE(jm.impact_factor, 0) AS "impactFactor"
      FROM journal_stats js
      LEFT JOIN journal_metrics jm ON js.journal_id = jm.journal_id
  `;
  try {
    const res = await client.query(sql);
    console.log("Without year filter:", res.rows);
  } catch (err) { console.error(err); }

  client.release();
  process.exit(0);
}
run();
