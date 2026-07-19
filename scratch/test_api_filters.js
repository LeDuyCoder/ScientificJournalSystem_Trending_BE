import app from '../src/app.js';
import { checkPostgres } from '../src/config/database.js';
import { checkRedis } from '../src/config/redis.js';

async function run() {
  try {
    await checkPostgres();
    await checkRedis();

    const PORT = 3006;
    const server = app.listen(PORT, async () => {
      console.log(`Test server running on port ${PORT}`);

      try {
        console.log('--- Request with Subject Area ---');
        const start1 = Date.now();
        const res1 = await fetch(`http://localhost:${PORT}/analytics/rankings?project_id=11&subject_area=Chemistry&limit=5`);
        const data1 = await res1.json();
        console.log('Status:', res1.status);
        console.log('Time 1:', Date.now() - start1, 'ms');
        console.log('Authors count:', data1.data?.authors?.length);

        console.log('--- Request with Keywords ---');
        const start2 = Date.now();
        const res2 = await fetch(`http://localhost:${PORT}/analytics/rankings?project_id=11&keywords=Artificial%20intelligence&limit=5`);
        const data2 = await res2.json();
        console.log('Status:', res2.status);
        console.log('Time 2:', Date.now() - start2, 'ms');
        console.log('Authors count:', data2.data?.authors?.length);

        if (res1.status === 200 && res2.status === 200) {
          console.log('Filters test: SUCCESS');
        } else {
          console.log('Filters test: FAILED');
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
