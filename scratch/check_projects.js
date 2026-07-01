import dotenv from 'dotenv';
dotenv.config();

import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

try {
  const res = await pool.query(`
    SELECT p.project_id, p.name, sa.display_name AS subject_area_name
    FROM "Project" p
    LEFT JOIN "Subject_Area" sa ON p.subject_area = sa.subject_area_id
  `);
  console.log('Projects in PostgreSQL database:');
  res.rows.forEach(r => {
    console.log(`- Project ID ${r.project_id}: "${r.name}" (${r.subject_area_name})`);
  });
} catch (err) {
  console.error(err);
} finally {
  await pool.end();
}
