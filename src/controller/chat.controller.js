import crypto from 'crypto';
import { chatPipeline } from '../services/rag-system.service.js';
import { redisGet, redisSet } from '../services/redis.service.js';
import { redisClient } from '../config/redis.js';
import logger from '../utils/logger.js';

const CHAT_CACHE_PREFIX = 'cache:chat:v2';
const CHAT_CACHE_TTL_SECONDS = process.env.CHAT_CACHE_TTL_SECONDS
    ? Number(process.env.CHAT_CACHE_TTL_SECONDS)
    : undefined;

const normalizeQuestionForCache = (question) => String(question || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

const buildChatCacheKey = (projectId, question) => {
    const normalizedQuestion = normalizeQuestionForCache(question);
    const questionHash = crypto
        .createHash('sha256')
        .update(normalizedQuestion)
        .digest('hex');

    return `${CHAT_CACHE_PREFIX}:project:${projectId}:question:${questionHash}`;
};

export const chatRagSystem = async (req, res) => {
    const requestBody = req.body;
    const projectId = requestBody ? (requestBody.project_id || requestBody.projectId) : null;
    
    if (!requestBody || !requestBody.message) {
        return res.status(400).json({ 
            success: false, 
            message: 'Message is required' 
        });
    }
    
    if (!projectId) {
        return res.status(400).json({
            success: false,
            message: 'project_id (or projectId) is required'
        });
    }
    
    try {
        const userQuestion = requestBody.message;
        const cacheKey = buildChatCacheKey(projectId, userQuestion);
        
        logger.info(`[CHAT API] Nhận yêu cầu: ${userQuestion} (Project ID: ${projectId})`);

        if (redisClient?.isOpen) {
            try {
                const cachedResult = await redisGet(cacheKey);
                if (cachedResult) {
                    logger.info(`[CHAT CACHE] Cache hit cho Project ID: ${projectId}, Key: ${cacheKey}`);
                    const parsedResult = JSON.parse(cachedResult);
                    return res.status(200).json({
                        success: true,
                        answer: parsedResult.answer
                    });
                }
                logger.info(`[CHAT CACHE] Cache miss cho Project ID: ${projectId}, Key: ${cacheKey}`);
            } catch (cacheError) {
                logger.warn('[CHAT CACHE] Không thể đọc cache Redis, tiếp tục xử lý pipeline:', cacheError?.message || cacheError);
            }
        }

        // Gọi pipeline xử lý Chatbot nếu chưa có cache
        const result = await chatPipeline(userQuestion, projectId);

        if (redisClient?.isOpen && !result.fromFallback) {
            try {
                await redisSet(cacheKey, JSON.stringify(result), CHAT_CACHE_TTL_SECONDS);
                logger.info(`[CHAT CACHE] Đã lưu cache cho Project ID: ${projectId}, Key: ${cacheKey}`);
            } catch (cacheError) {
                logger.warn('[CHAT CACHE] Không thể lưu cache Redis:', cacheError?.message || cacheError);
            }
        } else if (result.fromFallback) {
            logger.info(`[CHAT CACHE] Bỏ qua lưu cache vì AI dùng Smart Fallback (kết quả có thể chưa tối ưu).`);
        }

        return res.status(200).json({
            success: true,
            answer: result.answer
        });
        
    } catch (error) {
        logger.error('[CHAT API] Lỗi xử lý yêu cầu Chatbot:', error);
        return res.status(500).json({ 
            success: false, 
            message: 'Đã xảy ra lỗi hệ thống, vui lòng thử lại sau.' 
        });
    }
};