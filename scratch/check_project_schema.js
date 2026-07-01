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
  const columnsRes = await pool.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'Project'
  `);
  console.log('Columns in Project:');
  columnsRes.rows.forEach(c => {
    console.log(`- ${c.column_name} (${c.data_type})`);
  });

  const rowsRes = await pool.query('SELECT * FROM "Project" LIMIT 5');
  console.log('First 5 rows:');
  console.log(rowsRes.rows);
} catch (err) {
  console.error(err);
} finally {
  await pool.end();
}
