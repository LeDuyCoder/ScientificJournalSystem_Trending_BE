import dotenv from 'dotenv';
dotenv.config();

import pg from 'pg';
const { Pool } = pg;

const isLocal = process.env.POSTGRES_URL && (process.env.POSTGRES_URL.includes("localhost") || process.env.POSTGRES_URL.includes("127.0.0.1"));

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

try {
  const res = await pool.query(`
    SELECT 
      sa.subject_area_id, 
      sa.display_name, 
      count(distinct sc.subject_category_id) as categories_count,
      count(distinct t.topic_id) as topics_count,
      count(distinct a.article_id) as articles_count
    FROM "Subject_Area" sa
    LEFT JOIN "Subject_Category" sc ON sa.subject_area_id = sc.subject_area_id
    LEFT JOIN "Topic" t ON sc.subject_category_id = t.subject_category_id
    LEFT JOIN "Article" a ON t.topic_id = a.primary_topic
    GROUP BY sa.subject_area_id, sa.display_name
    ORDER BY articles_count DESC
  `);
  console.log('Subject Area counts:');
  res.rows.forEach(r => {
    console.log(`- ID ${r.subject_area_id}: "${r.display_name}" - Categories: ${r.categories_count}, Topics: ${r.topics_count}, Articles: ${r.articles_count}`);
  });
} catch (err) {
  console.error(err);
} finally {
  await pool.end();
}
