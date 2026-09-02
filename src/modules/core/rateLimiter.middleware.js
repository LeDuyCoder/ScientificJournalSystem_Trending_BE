import { redisClient } from '../../config/redis.js';
import logger from '../../utils/logger.js';

// Fallback Map lưu trữ rate limit trong bộ nhớ RAM nếu không dùng Redis
const inMemoryCache = new Map();

// Tự động dọn dẹp bộ nhớ định kỳ sau mỗi phút để tránh memory leak
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of inMemoryCache.entries()) {
        if (value.expiry < now) {
            inMemoryCache.delete(key);
        }
    }
}, 60000);

/**
 * Middleware giới hạn rate limit cho Chat API.
 * Giới hạn: 5 requests / 1 phút (60 giây) cho 1 User (IP) trên 1 Project.
 */
export const chatRateLimiter = async (req, res) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown-ip';
    const requestBody = req.body || {};
    const projectId = requestBody.project_id || requestBody.projectId || 'unknown-project';
    
    const limit = 5;
    const windowInSeconds = 60; // 1 phút
    const key = `rate_limit:chat:${ip}:${projectId}`;

    // Kiểm tra xem Redis có đang hoạt động hay không
    const isRedisReady = redisClient && redisClient.isOpen;

    if (isRedisReady) {
        try {
            const currentCount = await redisClient.incr(key);
            if (currentCount === 1) {
                await redisClient.expire(key, windowInSeconds);
            }
            if (currentCount > limit) {
                logger.warn(`[Rate Limit] (Redis) Bị chặn yêu cầu chat từ IP: ${ip} cho Project ID: ${projectId}. (Count: ${currentCount})`);
                return res.status(429).json({
                    success: false,
                    message: 'Bạn đã vượt quá giới hạn 5 yêu cầu chat mỗi phút cho dự án này. Vui lòng thử lại sau.'
                });
            }
            return;
        } catch (error) {
            logger.error('[Rate Limit] Lỗi Redis rate limiter, tự động chuyển sang fallback bộ nhớ RAM:', error);
            // Tiếp tục xuống phần xử lý in-memory fallback bên dưới
        }
    }

    // --- In-Memory Fallback ---
    try {
        const now = Date.now();
        const record = inMemoryCache.get(key);

        if (!record || record.expiry < now) {
            inMemoryCache.set(key, {
                count: 1,
                expiry: now + (windowInSeconds * 1000)
            });
        } else {
            record.count += 1;
            if (record.count > limit) {
                logger.warn(`[Rate Limit] (In-Memory) Bị chặn yêu cầu chat từ IP: ${ip} cho Project ID: ${projectId}. (Count: ${record.count})`);
                return res.status(429).json({
                    success: false,
                    message: 'Bạn đã vượt quá giới hạn 5 yêu cầu chat mỗi phút cho dự án này. Vui lòng thử lại sau.'
                });
            }
        }
        return;
    } catch (error) {
        logger.error('[Rate Limit] Lỗi xử lý In-Memory fallback rate limiter:', error);
        // Trong trường hợp lỗi nghiêm trọng xảy ra, cho phép request đi tiếp để tránh gián đoạn
        return;
    }
};

