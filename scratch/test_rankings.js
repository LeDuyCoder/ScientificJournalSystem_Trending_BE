import pool from '../src/config/database.js';
import { getInfluentialRankings } from '../src/services/rankings.service.js';

async function test() {
  try {
    console.log('Running rankings query...');
    const start = Date.now();
    const data = await getInfluentialRankings(11, { limit: 10 });
    console.log('Rankings data fetched successfully in', Date.now() - start, 'ms');
    console.log('Authors:', data.authors.length);
    console.log('Institutions:', data.institutions.length);
  } catch (e) {
    console.error('Error fetching rankings:', e);
  } finally {
    process.exit(0);
  }
}

test();
