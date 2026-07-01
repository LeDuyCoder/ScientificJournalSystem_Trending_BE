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
  const res = await pool.query('SELECT project_id, name, subject_area FROM "Project" WHERE project_id = 2');
  console.log(res.rows);
} catch (err) {
  console.error(err);
} finally {
  await pool.end();
}
