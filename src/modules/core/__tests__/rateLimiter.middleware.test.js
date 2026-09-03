import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chatRateLimiter } from '../rateLimiter.middleware.js';
import { redisClient } from '../../../config/redis.js';
import logger from '../../../utils/logger.js';

vi.mock('../../../config/redis.js', () => ({
  redisClient: {
    isOpen: true,
    incr: vi.fn(),
    expire: vi.fn(),
  },
}));

vi.mock('../../../utils/logger.js', () => ({
  default: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Rate Limiter Middleware', () => {
  let mockReq;
  let mockRes;
  
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    mockReq = {
      ip: '127.0.0.1',
      body: { project_id: 'proj1' },
    };

    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Redis Mode', () => {
    it('should set expiration when count is 1', async () => {
      redisClient.isOpen = true;
      redisClient.incr.mockResolvedValue(1);

      await chatRateLimiter(mockReq, mockRes);

      expect(redisClient.incr).toHaveBeenCalledWith('rate_limit:chat:127.0.0.1:proj1');
      expect(redisClient.expire).toHaveBeenCalledWith('rate_limit:chat:127.0.0.1:proj1', 60);
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should allow request if under limit', async () => {
      redisClient.isOpen = true;
      redisClient.incr.mockResolvedValue(3);

      await chatRateLimiter(mockReq, mockRes);

      expect(redisClient.incr).toHaveBeenCalled();
      expect(redisClient.expire).not.toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should block request and return 429 if over limit', async () => {
      redisClient.isOpen = true;
      redisClient.incr.mockResolvedValue(6);

      await chatRateLimiter(mockReq, mockRes);

      expect(logger.warn).toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(429);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        message: 'Bạn đã vượt quá giới hạn 5 yêu cầu chat mỗi phút cho dự án này. Vui lòng thử lại sau.'
      });
    });

    it('should fallback to in-memory if Redis throws error', async () => {
      redisClient.isOpen = true;
      redisClient.incr.mockRejectedValue(new Error('Redis connection lost'));

      await chatRateLimiter(mockReq, mockRes);

      expect(logger.error).toHaveBeenCalled();
      // It will fall back to in-memory, which for a new key should be 1
      expect(mockRes.status).not.toHaveBeenCalled();
    });
  });

  describe('In-Memory Fallback Mode', () => {
    beforeEach(() => {
      redisClient.isOpen = false;
    });

    it('should allow request when under limit', async () => {
      await chatRateLimiter(mockReq, mockRes);
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should block request after 5 attempts', async () => {
      mockReq.ip = '192.168.1.1';
      for (let i = 0; i < 5; i++) {
        await chatRateLimiter(mockReq, mockRes);
        expect(mockRes.status).not.toHaveBeenCalled();
      }

      await chatRateLimiter(mockReq, mockRes);
      expect(mockRes.status).toHaveBeenCalledWith(429);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        message: 'Bạn đã vượt quá giới hạn 5 yêu cầu chat mỗi phút cho dự án này. Vui lòng thử lại sau.'
      });
    });
  });
});
