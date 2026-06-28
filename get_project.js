import pool from './src/config/database.js';

async function main() {
  const res = await pool.query('SELECT project_id FROM "Project" LIMIT 1');
  console.log(res.rows);
  process.exit(0);
}
main();
