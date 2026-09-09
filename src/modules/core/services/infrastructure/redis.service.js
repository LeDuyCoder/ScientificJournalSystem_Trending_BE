import { redisClient } from '../../../../config/redis.js';

/**
 * Get a string value from Redis.
 *
 * @param {string} key
 * @returns {Promise<string|null>}
 */
export async function redisGet(key) {
  return redisClient.get(key);
}

/**
 * Set a string value in Redis.
 *
 * @param {string} key
 * @param {string} value
 * @param {number|undefined} ttlSeconds - Optional TTL in seconds.
 * @returns {Promise<void|unknown>} Result returned by redis client.
 */
export async function redisSet(key, value, ttlSeconds) {
  if (ttlSeconds) {
    return redisClient.set(key, value, { EX: ttlSeconds });
  }
  return redisClient.set(key, value);
}

export async function redisDel(key) {
  try {
    return await redisClient.del(key);
  } catch (err) {
    return null;
  }
}

export async function redisDeletePattern(pattern) {
  try {
    const keys = await redisClient.keys(pattern);
    if (keys && keys.length > 0) {
      await redisClient.del(keys);
    }
  } catch (err) {
    // Ignore cache deletion error
  }
}
