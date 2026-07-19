import pool from '../src/config/database.js';

async function check() {
  try {
    const res = await pool.query(`
      SELECT
        t.relname as table_name,
        i.relname as index_name,
        a.attname as column_name
      FROM
        pg_class t,
        pg_class i,
        pg_index ix,
        pg_attribute a
      WHERE
        t.oid = ix.indrelid
        AND i.oid = ix.indexrelid
        AND a.attrelid = t.oid
        AND a.attnum = ANY(ix.indkey)
        AND t.relname IN ('Author_Article', 'Institution_Author', 'Article', 'Author')
      ORDER BY
        t.relname,
        i.relname;
    `);
    console.log('Indexes:');
    console.table(res.rows);
  } catch (e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}
check();
