import crypto from 'crypto';
import { chatPipeline } from '../services/rag/rag-system.service.js';
import { redisGet, redisSet } from '../services/infrastructure/redis.service.js';
import { redisClient } from '../config/redis.js';
import {
  createChatMessage,
  deleteChatMessage,
  deleteProjectChatMessages,
  getChatMessageById,
  getProjectChatMessages,
  updateChatMessage
} from '../services/rag/projectChatMessage.service.js';
import logger from '../utils/logger.js';

const CHAT_CACHE_PREFIX = 'cache:chat:v3';
const CHAT_CACHE_TTL_SECONDS = process.env.CHAT_CACHE_TTL_SECONDS
  ? Number(process.env.CHAT_CACHE_TTL_SECONDS)
  : undefined;

const getActiveChatModel = () => {
  if (process.env.AI_PROVIDER === 'gemini') return process.env.AI_MODEL || 'gemini';
  if (process.env.AI_PROVIDER === 'openai') return process.env.AI_MODEL || 'openai';
  return process.env.AI_MODEL || process.env.OLLAMA_MODEL || process.env.RAG_MODEL || 'ollama';
};

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

const saveChatMessageSafely = async (payload) => {
  try {
    return await createChatMessage(payload);
  } catch (error) {
    logger.warn('[CHAT HISTORY] Kh�ng th? luu l?ch s? chat:', error?.message || error);
    return null;
  }
};

const parseProjectId = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const parseMessageId = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

export const chatRagSystem = async (req, res) => {
  const requestBody = req.body;
  const projectId = parseProjectId(requestBody ? (requestBody.project_id || requestBody.projectId) : null);
  const userId = req.user?.user_id;
  const startedAt = Date.now();

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

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: 'Vui l�ng dang nh?p d? ti?p t?c.'
    });
  }

  let userMessage = null;

  try {
    const userQuestion = requestBody.message;
    const cacheKey = buildChatCacheKey(projectId, userQuestion);

    logger.info(`[CHAT API] Nh?n y�u c?u: ${userQuestion} (Project ID: ${projectId}, User ID: ${userId})`);

    userMessage = await saveChatMessageSafely({
      projectId,
      userId,
      role: 'USER',
      content: userQuestion,
      status: 'COMPLETED'
    });

    if (redisClient?.isOpen) {
      try {
        const cachedResult = await redisGet(cacheKey);
        if (cachedResult) {
          logger.info(`[CHAT CACHE] Cache hit cho Project ID: ${projectId}, Key: ${cacheKey}`);
          const parsedResult = JSON.parse(cachedResult);
          const assistantMessage = await saveChatMessageSafely({
            projectId,
            userId,
            role: 'ASSISTANT',
            content: parsedResult.answer,
            model: 'cache',
            latencyMs: Date.now() - startedAt,
            status: 'COMPLETED'
          });

          return res.status(200).json({
            success: true,
            answer: parsedResult.answer,
            messages: {
              user_message_id: userMessage?.message_id || null,
              assistant_message_id: assistantMessage?.message_id || null
            }
          });
        }
        logger.info(`[CHAT CACHE] Cache miss cho Project ID: ${projectId}, Key: ${cacheKey}`);
      } catch (cacheError) {
        logger.warn('[CHAT CACHE] Kh�ng th? d?c cache Redis, ti?p t?c x? l� pipeline:', cacheError?.message || cacheError);
      }
    }

    const result = await chatPipeline(userQuestion, projectId, userId);

    if (redisClient?.isOpen && !result.fromFallback) {
      try {
        await redisSet(cacheKey, JSON.stringify(result), CHAT_CACHE_TTL_SECONDS);
        logger.info(`[CHAT CACHE] �� luu cache cho Project ID: ${projectId}, Key: ${cacheKey}`);
      } catch (cacheError) {
        logger.warn('[CHAT CACHE] Kh�ng th? luu cache Redis:', cacheError?.message || cacheError);
      }
    } else if (result.fromFallback) {
      logger.info('[CHAT CACHE] B? qua luu cache v� AI d�ng Smart Fallback (k?t qu? c� th? chua t?i uu).');
    }

    const assistantMessage = await saveChatMessageSafely({
      projectId,
      userId,
      role: 'ASSISTANT',
      content: result.answer,
      model: getActiveChatModel(),
      promptTokens: result.tokens?.promptTokens || 0,
      completionTokens: result.tokens?.completionTokens || 0,
      totalTokens: result.tokens?.totalTokens || 0,
      latencyMs: Date.now() - startedAt,
      status: result.fromFallback ? 'ERROR' : 'COMPLETED'
    });

    return res.status(200).json({
      success: true,
      answer: result.answer,
      messages: {
        user_message_id: userMessage?.message_id || null,
        assistant_message_id: assistantMessage?.message_id || null
      }
    });
  } catch (error) {
    logger.error('[CHAT API] L?i x? l� y�u c?u Chatbot:', error);

    await saveChatMessageSafely({
      projectId,
      userId,
      role: 'ASSISTANT',
      content: '�� x?y ra l?i h? th?ng, vui l�ng th? l?i sau.',
      model: getActiveChatModel(),
      latencyMs: Date.now() - startedAt,
      status: 'ERROR'
    });

    return res.status(500).json({
      success: false,
      message: '�� x?y ra l?i h? th?ng, vui l�ng th? l?i sau.'
    });
  }
};

export const createChatMessageHandler = async (req, res) => {
  try {
    const projectId = parseProjectId(req.params.projectId);
    const userId = req.user?.user_id;

    if (!projectId) {
      return res.status(400).json({ success: false, message: 'projectId is invalid' });
    }

    const message = await createChatMessage({
      projectId,
      userId,
      role: req.body.role,
      content: req.body.content,
      model: req.body.model,
      promptTokens: req.body.prompt_tokens ?? req.body.promptTokens,
      completionTokens: req.body.completion_tokens ?? req.body.completionTokens,
      totalTokens: req.body.total_tokens ?? req.body.totalTokens,
      latencyMs: req.body.latency_ms ?? req.body.latencyMs,
      status: req.body.status || 'COMPLETED'
    });

    return res.status(201).json({ success: true, data: message });
  } catch (error) {
    logger.error('[CHAT MESSAGE] L?i t?o message:', error);
    return res.status(500).json({ success: false, message: '�� x?y ra l?i khi t?o chat message.' });
  }
};

export const getChatHistory = async (req, res) => {
  try {
    const projectId = parseProjectId(req.params.projectId);
    const userId = req.user?.user_id;

    if (!projectId) {
      return res.status(400).json({ success: false, message: 'projectId is invalid' });
    }

    const messages = await getProjectChatMessages(projectId, userId, {
      limit: req.query.limit,
      offset: req.query.offset,
      order: req.query.order
    });

    return res.status(200).json({ success: true, data: messages });
  } catch (error) {
    logger.error('[CHAT MESSAGE] L?i l?y l?ch s? chat:', error);
    return res.status(500).json({ success: false, message: '�� x?y ra l?i khi l?y l?ch s? chat.' });
  }
};

export const getChatMessageDetail = async (req, res) => {
  try {
    const projectId = parseProjectId(req.params.projectId);
    const messageId = parseMessageId(req.params.messageId);
    const userId = req.user?.user_id;

    if (!projectId || !messageId) {
      return res.status(400).json({ success: false, message: 'projectId or messageId is invalid' });
    }

    const message = await getChatMessageById(messageId, projectId, userId);
    if (!message) {
      return res.status(404).json({ success: false, message: 'Chat message not found' });
    }

    return res.status(200).json({ success: true, data: message });
  } catch (error) {
    logger.error('[CHAT MESSAGE] L?i l?y chi ti?t message:', error);
    return res.status(500).json({ success: false, message: '�� x?y ra l?i khi l?y chi ti?t chat message.' });
  }
};

export const updateChatMessageHandler = async (req, res) => {
  try {
    const projectId = parseProjectId(req.params.projectId);
    const messageId = parseMessageId(req.params.messageId);
    const userId = req.user?.user_id;

    if (!projectId || !messageId) {
      return res.status(400).json({ success: false, message: 'projectId or messageId is invalid' });
    }

    const message = await updateChatMessage(messageId, projectId, userId, req.body);
    if (!message) {
      return res.status(404).json({ success: false, message: 'Chat message not found' });
    }

    return res.status(200).json({ success: true, data: message });
  } catch (error) {
    logger.error('[CHAT MESSAGE] L?i c?p nh?t message:', error);
    return res.status(500).json({ success: false, message: '�� x?y ra l?i khi c?p nh?t chat message.' });
  }
};

export const deleteChatMessageHandler = async (req, res) => {
  try {
    const projectId = parseProjectId(req.params.projectId);
    const messageId = parseMessageId(req.params.messageId);
    const userId = req.user?.user_id;

    if (!projectId || !messageId) {
      return res.status(400).json({ success: false, message: 'projectId or messageId is invalid' });
    }

    const result = await deleteChatMessage(messageId, projectId, userId);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    logger.error('[CHAT MESSAGE] L?i x�a m?t message:', error);
    return res.status(500).json({ success: false, message: '�� x?y ra l?i khi x�a chat message.' });
  }
};

export const clearChatHistory = async (req, res) => {
  try {
    const projectId = parseProjectId(req.params.projectId);
    const userId = req.user?.user_id;

    if (!projectId) {
      return res.status(400).json({ success: false, message: 'projectId is invalid' });
    }

    const result = await deleteProjectChatMessages(projectId, userId);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    logger.error('[CHAT MESSAGE] L?i x�a l?ch s? chat:', error);
    return res.status(500).json({ success: false, message: '�� x?y ra l?i khi x�a l?ch s? chat.' });
  }
};
