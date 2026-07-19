import pool from '../src/config/database.js';
import { getImpactQuartiles } from '../src/services/impactQuartiles.service.js';

async function test() {
  console.log('Starting test...');
  try {
    const res = await getImpactQuartiles(12);
    console.log('Result:', JSON.stringify(res, null, 2));
  } catch (err) {
    console.error('Error in test:', err);
  } finally {
    console.log('Ending pool...');
    await pool.end();
    console.log('Pool ended.');
  }
}
test();
