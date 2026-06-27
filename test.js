import pool from './src/config/database.js';
async function run() {
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT * FROM "Journal" LIMIT 1');
    if (res.rows.length > 0) {
      console.log('COLUMNS:', Object.keys(res.rows[0]));
    } else {
      console.log('Journal table is empty, getting schema...');
      const schemaRes = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'Journal'`);
      console.log('COLUMNS:', schemaRes.rows.map(r => r.column_name));
    }
  } catch(e) {
    console.error(e);
  } finally {
    client.release();
    process.exit(0);
  }
}
run();
