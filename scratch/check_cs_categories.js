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
    SELECT subject_category_id, display_name, subject_area_id
    FROM "Subject_Category"
    WHERE subject_area_id = 37
    LIMIT 10
  `);
  console.log('Categories under CS (subject_area_id = 37):');
  console.log(res.rows);
} catch (err) {
  console.error(err);
} finally {
  await pool.end();
}
