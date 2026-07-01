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
  const res = await pool.query('SELECT subject_area_id, display_name FROM "Subject_Area"');
  console.log('Subject Areas in Postgres:');
  res.rows.forEach(r => {
    console.log(`- ID ${r.subject_area_id}: "${r.display_name}"`);
  });
} catch (err) {
  console.error(err);
} finally {
  await pool.end();
}
