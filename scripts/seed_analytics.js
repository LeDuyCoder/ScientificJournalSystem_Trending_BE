import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

async function runSeeder() {
  console.log('🚀 Bắt đầu quá trình nạp dữ liệu (Seeding) cho Analytics Tables...');
  try {
    await pool.query('BEGIN');
    
    console.log('1. Xóa dữ liệu cũ (Truncate)...');
    await pool.query('TRUNCATE TABLE "analytics_topic_year" CASCADE');
    await pool.query('TRUNCATE TABLE "analytics_keyword_year" CASCADE');
    await pool.query('TRUNCATE TABLE "analytics_journal_year" CASCADE');
    await pool.query('TRUNCATE TABLE "analytics_country_year" CASCADE');

    console.log('2. Đang nạp dữ liệu cho analytics_topic_year...');
    await pool.query(`
      INSERT INTO "analytics_topic_year" (topic_id, year, article_count, citation_count)
      SELECT 
        primary_topic AS topic_id, 
        publication_year AS year, 
        COUNT(*)::integer AS article_count,
        SUM(COALESCE(citation_count, 0))::integer AS citation_count
      FROM "Article"
      WHERE primary_topic IS NOT NULL 
        AND publication_year IS NOT NULL 
        AND coalesce(is_deleted, false) = false
      GROUP BY primary_topic, publication_year
    `);

    console.log('3. Đang nạp dữ liệu cho analytics_keyword_year...');
    await pool.query(`
      INSERT INTO "analytics_keyword_year" (keyword_id, year, article_count, citation_count)
      SELECT 
        ka.keyword_id, 
        a.publication_year AS year, 
        COUNT(a.article_id)::integer AS article_count,
        SUM(COALESCE(a.citation_count, 0))::integer AS citation_count
      FROM "Keyword_Article" ka
      JOIN "Article" a ON ka.article_id = a.article_id
      WHERE a.publication_year IS NOT NULL 
        AND coalesce(a.is_deleted, false) = false
      GROUP BY ka.keyword_id, a.publication_year
    `);

    console.log('4. Đang nạp dữ liệu cho analytics_journal_year...');
    await pool.query(`
      INSERT INTO "analytics_journal_year" (journal_id, year, article_count, citation_count)
      SELECT 
        j.journal_id, 
        a.publication_year AS year, 
        COUNT(a.article_id)::integer AS article_count,
        SUM(COALESCE(a.citation_count, 0))::integer AS citation_count
      FROM "Article" a
      JOIN "Issue" i ON i.issue_id = a.issue_id
      JOIN "Volume" v ON v.volume_id = i.volume_id
      JOIN "Journal" j ON j.journal_id = v.journal_id
      WHERE a.publication_year IS NOT NULL 
        AND coalesce(a.is_deleted, false) = false
      GROUP BY j.journal_id, a.publication_year
    `);

    console.log('5. Đang nạp dữ liệu cho analytics_country_year...');
    await pool.query(`
      INSERT INTO "analytics_country_year" (country_code, year, article_count, citation_count)
      SELECT 
        j.country AS country_code, 
        a.publication_year AS year, 
        COUNT(a.article_id)::integer AS article_count,
        SUM(COALESCE(a.citation_count, 0))::integer AS citation_count
      FROM "Article" a
      JOIN "Issue" i ON i.issue_id = a.issue_id
      JOIN "Volume" v ON v.volume_id = i.volume_id
      JOIN "Journal" j ON j.journal_id = v.journal_id
      WHERE a.publication_year IS NOT NULL 
        AND j.country IS NOT NULL
        AND coalesce(a.is_deleted, false) = false
      GROUP BY j.country, a.publication_year
    `);

    await pool.query('COMMIT');
    console.log('✅ Hoàn thành mồi dữ liệu (Seeding) thành công!');
    process.exit(0);
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('❌ Lỗi khi mồi dữ liệu:', error);
    process.exit(1);
  }
}

runSeeder();
