import pool from '../src/config/database.js';

async function testFastDashboard() {
  const projectId = 12;
  const currentYear = 2026; // Example
  const previousYear = 2025; // Example
  const scopeFilter = `
    (EXISTS (
      SELECT 1 FROM "Topic" t
      WHERE t.topic_id = a.primary_topic
        AND t.subject_category_id = ANY($3::bigint[])
    ) OR EXISTS (
      SELECT 1 FROM "Topic" sub_topic
      WHERE sub_topic.topic_id IN (
        SELECT st.topic_id FROM "Sub_Topic" st
        WHERE st.article_id = a.article_id
          AND sub_topic.subject_category_id = ANY($3::bigint[])
      )
    ) OR EXISTS (
      SELECT 1
      FROM "Keyword_Article" ka
      WHERE ka.article_id = a.article_id
        AND ka.keyword_id = ANY($4::bigint[])
    ))
  `;

  // Assume project 12 has category [1] and keyword [1] for testing.
  const params = [currentYear, previousYear, [1, 2], [1, 2]];

  const combinedQuery = `
WITH project_articles AS (
    SELECT a.article_id, a.publication_year, a.citation_count, a.issue_id
    FROM "Article" a
    WHERE ${scopeFilter} AND COALESCE(a.is_deleted, false) = false
),
art_cit_stats AS (
    SELECT
        COUNT(article_id) AS total_articles,
        COUNT(CASE WHEN publication_year = $1 THEN article_id END) AS current_articles,
        COUNT(CASE WHEN publication_year = $2 THEN article_id END) AS previous_articles,
        COALESCE(SUM(citation_count), 0) AS total_citations,
        COALESCE(SUM(CASE WHEN publication_year = $1 THEN citation_count ELSE 0 END), 0) AS current_citations,
        COALESCE(SUM(CASE WHEN publication_year = $2 THEN citation_count ELSE 0 END), 0) AS previous_citations
    FROM project_articles
),
journal_stats AS (
    SELECT
        COUNT(DISTINCT j.journal_id) AS total_journals,
        COUNT(DISTINCT CASE WHEN pa.publication_year = $1 THEN j.journal_id END) AS current_journals,
        COUNT(DISTINCT CASE WHEN pa.publication_year = $2 THEN j.journal_id END) AS previous_journals
    FROM project_articles pa
    JOIN "Issue" iss ON pa.issue_id = iss.issue_id
    JOIN "Volume" v ON iss.volume_id = v.volume_id
    JOIN "Journal" j ON v.journal_id = j.journal_id
    WHERE COALESCE(j.is_deleted, false) = false
),
author_stats AS (
    SELECT
        COUNT(DISTINCT aa.author_id) AS total_authors,
        COUNT(DISTINCT CASE WHEN pa.publication_year = $1 THEN aa.author_id END) AS current_authors,
        COUNT(DISTINCT CASE WHEN pa.publication_year = $2 THEN aa.author_id END) AS previous_authors
    FROM project_articles pa
    JOIN "Author_Article" aa ON pa.article_id = aa.article_id
    JOIN "Author" au ON aa.author_id = au.author_id
    WHERE COALESCE(au.is_deleted, false) = false
)
SELECT
    (SELECT row_to_json(art_cit_stats) FROM art_cit_stats) AS articles_citations,
    (SELECT row_to_json(journal_stats) FROM journal_stats) AS journals,
    (SELECT row_to_json(author_stats) FROM author_stats) AS authors;
  `;

  try {
    const start = Date.now();
    const res = await pool.query(combinedQuery, params);
    console.log('Combined Query Time:', Date.now() - start, 'ms');
    console.log(JSON.stringify(res.rows[0], null, 2));
  } catch (err) {
    console.error('Error:', err);
  } finally {
    process.exit(0);
  }
}

testFastDashboard();
