import dotenv from 'dotenv';

dotenv.config();

import app from './src/app.js';
import pool, { checkPostgres } from './src/config/database.js';
import { checkRedis, closeRedis } from './src/config/redis.js';
import { checkNeo4j, closeNeo4j } from './src/config/neo4j.js';
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

async function bootstrap() {
  // Required DB connections. Failure should prevent startup.
  try {
    await checkPostgres();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('PostgreSQL connection failed. Server cannot start.', e?.message || e);
    throw e; // Re-throw to be caught by the final catch block
  }

  // Optional DB connections for local dev.
  // If Redis/Neo4j are not available, server can still start (health + swagger).
  try {
    await checkRedis();
    // eslint-disable-next-line no-console
    console.log('Redis connected successfully');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('Redis connection failed (continuing without Redis):', e?.message || e);
  }

  try {
    await checkNeo4j();
    // eslint-disable-next-line no-console
    console.log('Neo4j connected successfully');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('Neo4j connection failed (continuing without Neo4j):', e?.message || e);
  }

  const server = app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Server running on http://localhost:${PORT}`);
  });

  const shutdown = async () => {
    // eslint-disable-next-line no-console
    console.log('Shutting down...');
    try {
      await pool.end();
    } catch (e) {
      // ignore
    }

    try {
      await closeRedis();
    } catch (e) {
      // ignore
    }

    try {
      if (closeNeo4j) await closeNeo4j();
    } catch (e) {
      // ignore
    }

    server.close(() => process.exit(0));
  };


  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Bootstrap error:', err);
  process.exit(1);
});


