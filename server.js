import dotenv from 'dotenv';
dotenv.config();

import fastifyApp from './src/app.js';
import prisma from './src/config/prisma.js';
import { checkRedis, closeRedis } from './src/config/redis.js';
import { checkNeo4j, closeNeo4j } from './src/config/neo4j.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

async function bootstrap() {
  // Required DB connections.
  try {
    await prisma.$connect();
    console.log('PostgreSQL (Prisma) connected successfully');
  } catch (e) {
    console.error('PostgreSQL connection failed. Server cannot start.', e?.message || e);
    throw e;
  }

  // Optional DB connections
  try {
    await checkRedis();
    console.log('Redis connected successfully');
  } catch (e) {
    console.warn('Redis connection failed (continuing without Redis):', e?.message || e);
  }

  try {
    await checkNeo4j();
    console.log('Neo4j connected successfully');
  } catch (e) {
    console.warn('Neo4j connection failed (continuing without Neo4j):', e?.message || e);
  }



  try {
    await fastifyApp.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`Server running on http://localhost:${PORT}`);
  } catch (err) {
    console.error('Error starting server:', err);
    process.exit(1);
  }

  const shutdown = async () => {
    console.log('Shutting down...');
    await fastifyApp.close();

    try {
      await Promise.allSettled([
        prisma.$disconnect(),
        closeRedis(),
        closeNeo4j ? closeNeo4j() : Promise.resolve(),
      ]);
    } catch {
      // ignore
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((err) => {
  console.error('Bootstrap error:', err);
  process.exit(1);
});
