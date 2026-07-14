import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

export const redisClient = createClient({
  url: REDIS_URL,
});

// Lắng nghe sự kiện lỗi kết nối để tránh làm sập ứng dụng (prevent unhandled error crash)
redisClient.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('Redis Client Error:', err?.message || err);
});

/**
 * Connect to Redis if not connected yet.
 *
 * @returns {Promise<void>}
 */
export async function connectRedis() {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
}


/**
 * Verify Redis connection by connecting (if needed) and sending PING.
 *
 * @returns {Promise<{ok: true}>}
 * @throws {Error} When Redis is unreachable or PING response is unexpected.
 */
export async function checkRedis() {
  await connectRedis();
  // Ensure connection is really alive
  const pong = await redisClient.ping();
  if (pong !== 'PONG' && pong !== 'pong') {
    throw new Error(`Unexpected Redis PING response: ${pong}`);
  }
  return { ok: true };
}


/**
 * Close Redis connection (if open).
 *
 * @returns {Promise<void>}
 */
export async function closeRedis() {
  try {
    if (redisClient.isOpen) {
      await redisClient.quit();
    }
  } catch {
    // ignore
  }
}


