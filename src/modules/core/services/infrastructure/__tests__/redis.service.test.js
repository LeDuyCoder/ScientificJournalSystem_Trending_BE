import { describe, it, expect, vi, beforeEach } from 'vitest';
import { redisGet, redisSet } from '../redis.service.js';
import { redisClient } from '../../../../../config/redis.js';

vi.mock('../../../../../config/redis.js', () => ({
  redisClient: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

describe('Redis Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('redisGet', () => {
    it('should call redisClient.get with correct key', async () => {
      redisClient.get.mockResolvedValue('test_value');

      const result = await redisGet('test_key');

      expect(redisClient.get).toHaveBeenCalledWith('test_key');
      expect(result).toBe('test_value');
    });
  });

  describe('redisSet', () => {
    it('should call redisClient.set without EX if ttlSeconds is undefined', async () => {
      await redisSet('test_key', 'test_value');

      expect(redisClient.set).toHaveBeenCalledWith('test_key', 'test_value');
    });

    it('should call redisClient.set with EX if ttlSeconds is provided', async () => {
      await redisSet('test_key', 'test_value', 3600);

      expect(redisClient.set).toHaveBeenCalledWith('test_key', 'test_value', { EX: 3600 });
    });
  });
});
