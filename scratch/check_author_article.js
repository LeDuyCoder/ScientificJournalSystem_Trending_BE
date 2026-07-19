import pool from '../src/config/database.js';

async function check() {
  try {
    const res = await pool.query(`
      SELECT tablename, indexname, indexdef 
      FROM pg_indexes 
      WHERE tablename = 'Author_Article'
      ORDER BY indexname;
    `);
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}
check();
