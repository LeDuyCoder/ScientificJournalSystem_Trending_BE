import { redisClient } from '../config/redis.js';

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


