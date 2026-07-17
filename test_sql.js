import pool from './src/config/database.js';
import { getProjectScope } from './src/services/forecast.service.js';

async function test() {
  try {
    const scope = await getProjectScope(pool, 12);
    console.log('Project Categories:', scope.subjectCategoryIds);

    const sql = `
      EXPLAIN ANALYZE
      WITH target_topics AS (
        SELECT topic_id FROM "Topic" WHERE subject_category_id = ANY($1::bigint[])
      ),
      project_articles_issues AS (
        SELECT issue_id, article_id
        FROM "Article"
        WHERE primary_topic IN (SELECT topic_id FROM target_topics)
          AND coalesce(is_deleted, false) = false
        UNION
        SELECT a.issue_id, a.article_id
        FROM "Sub_Topic" st
        JOIN "Article" a ON st.article_id = a.article_id
        WHERE st.topic_id IN (SELECT topic_id FROM target_topics)
          AND coalesce(a.is_deleted, false) = false
      ),
      issue_counts AS (
        SELECT issue_id, COUNT(DISTINCT article_id) AS cnt
        FROM project_articles_issues
        GROUP BY issue_id
      ),
      journal_stats AS (
        SELECT 
          v.journal_id, 
          SUM(ic.cnt) AS article_count
        FROM issue_counts ic
        JOIN "Issue" i ON ic.issue_id = i.issue_id
        JOIN "Volume" v ON i.volume_id = v.volume_id
        GROUP BY v.journal_id
      )
      SELECT * FROM journal_stats LIMIT 10;
    `;

    const res = await pool.query(sql, [scope.subjectCategoryIds]);
    for (const r of res.rows) {
      console.log(r['QUERY PLAN']);
    }
  } catch (e) {
    console.error(e);
  } finally {
    await pool.end();
  }
}
test();
