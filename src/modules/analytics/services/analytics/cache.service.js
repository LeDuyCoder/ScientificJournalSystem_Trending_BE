import { redisGet, redisSet } from '../../../core/services/infrastructure/redis.service.js';
import logger from '../../../../utils/logger.js';

/**
 * Advanced caching strategy with Stale-While-Revalidate pattern.
 * If data is in cache but near expiry (or we want to update it), it returns stale data 
 * immediately and fires a background promise to refresh the cache.
 */

const SWR_WINDOW = 60; // seconds before TTL expires to consider data "stale" but usable

export async function fetchWithCache(cacheKey, ttl, fetchPromiseFn) {
  try {
    const raw = await redisGet(cacheKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      // parsed = { data: ..., cachedAt: timestamp, ttl: number }
      
      const now = Date.now();
      const expiresAt = parsed.cachedAt + (parsed.ttl * 1000);
      const isStale = (expiresAt - now) < (SWR_WINDOW * 1000);

      if (isStale) {
        // Trigger background refresh with fire-and-forget pattern
        // This prevents blocking the current request while refreshing in the background
        logger.info(`[Redis SWR] Cache near expiry for ${cacheKey}, scheduling background refresh...`);
        fetchPromiseFn()
          .then(async (freshData) => {
            const payload = {
              data: freshData,
              cachedAt: Date.now(),
              ttl: ttl
            };
            await redisSet(cacheKey, JSON.stringify(payload), ttl);
            logger.info(`[Redis SWR] Background refresh completed for ${cacheKey}`);
          })
          .catch(err => {
            logger.error(`[Redis SWR] Background refresh failed for ${cacheKey}:`, err?.message || err);
          });
        // Return stale data immediately without waiting for refresh
      }

      logger.info(`[Redis] Cache hit for ${cacheKey}`);
      return parsed.data;
    }
  } catch (err) {
    logger.warn(`[Redis] Cache error on get for ${cacheKey}:`, err?.message || err);
  }

  // Cache miss
  logger.info(`[Redis] Cache miss for ${cacheKey}. Computing...`);
  const freshData = await fetchPromiseFn();
  
  try {
    const payload = {
      data: freshData,
      cachedAt: Date.now(),
      ttl: ttl
    };
    await redisSet(cacheKey, JSON.stringify(payload), ttl);
  } catch (err) {
    logger.warn(`[Redis] Cache error on set for ${cacheKey}:`, err?.message || err);
  }

  return freshData;
}
