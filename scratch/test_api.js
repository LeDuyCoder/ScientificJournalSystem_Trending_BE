import app from '../src/app.js';
import { checkPostgres } from '../src/config/database.js';
import { checkRedis } from '../src/config/redis.js';

async function run() {
  try {
    await checkPostgres();
    console.log('Postgres OK');
    await checkRedis();
    console.log('Redis OK');

    const PORT = 3005;
    const server = app.listen(PORT, async () => {
      console.log(`Test server running on port ${PORT}`);

      try {
        console.log('--- Request 1 (Cache Miss) ---');
        const start1 = Date.now();
        const res1 = await fetch(`http://localhost:${PORT}/analytics/rankings?project_id=11&limit=10`);
        const data1 = await res1.json();
        console.log('Status:', res1.status);
        console.log('Time 1:', Date.now() - start1, 'ms');
        console.log('Data sample:', data1.data?.authors?.slice(0, 2));

        console.log('--- Request 2 (Cache Hit) ---');
        const start2 = Date.now();
        const res2 = await fetch(`http://localhost:${PORT}/analytics/rankings?project_id=11&limit=10`);
        const data2 = await res2.json();
        console.log('Status:', res2.status);
        console.log('Time 2:', Date.now() - start2, 'ms');

        if (res1.status === 200 && res2.status === 200) {
          console.log('Integration test: SUCCESS');
        } else {
          console.log('Integration test: FAILED');
        }

      } catch (err) {
        console.error('Error during fetch:', err);
      } finally {
        server.close(() => {
          console.log('Test server closed');
          process.exit(0);
        });
      }
    });

  } catch (err) {
    console.error('Setup failed:', err);
    process.exit(1);
  }
}

run();
