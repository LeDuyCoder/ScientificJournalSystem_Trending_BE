import { redisGet, redisDel } from '../src/services/redis.service.js';

async function run() {
  const keys = [
    'analytics:impact-quartiles:12::::',
    'analytics:impact-quartiles:12:::',
    'analytics:impact-quartiles:12::'
  ];

  for (const k of keys) {
    const val = await redisGet(k);
    console.log(`Key: ${k} ->`, val);
    if (val) {
      await redisDel(k);
      console.log(`Deleted key: ${k}`);
    }
  }
  process.exit(0);
}
run();
