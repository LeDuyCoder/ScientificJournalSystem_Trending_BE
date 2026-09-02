
import {
  chatRagSystem,
  clearChatHistory,
  createChatMessageHandler,
  deleteChatMessageHandler,
  getChatHistory,
  getChatMessageDetail,
  updateChatMessageHandler
} from './chat.controller.js';
import { requireAuth } from '../auth/auth.middleware.js';
import { chatRateLimiter } from '../core/rateLimiter.middleware.js';
import { parseCookies } from '../../utils/authToken.utils.js';

export default async function (fastify, opts) {

/**
 * @openapi
 * components:
 *   schemas:
 *     ChatMessage:
 *       type: object
 *       properties:
 *         message_id:
 *           type: integer
 *           format: int64
 *           example: 1
 *         project_id:
 *           type: integer
 *           format: int64
 *           example: 12
 *         user_id:
 *           type: string
 *           format: uuid
 *           example: "550e8400-e29b-41d4-a716-446655440000"
 *         role:
 *           type: string
 *           enum: [USER, ASSISTANT, SYSTEM]
 *           example: USER
 *         content:
 *           type: string
 *           example: "Bài báo nào có lượt trích dẫn cao nhất?"
 *         model:
 *           type: string
 *           nullable: true
 *           example: "llama3.1:8b"
 *         prompt_tokens:
 *           type: integer
 *           example: 0
 *         completion_tokens:
 *           type: integer
 *           example: 0
 *         total_tokens:
 *           type: integer
 *           example: 0
 *         latency_ms:
 *           type: integer
 *           nullable: true
 *           example: 1520
 *         status:
 *           type: string
 *           enum: [PENDING, COMPLETED, ERROR]
 *           example: COMPLETED
 *         created_at:
 *           type: string
 *           format: date-time
 *     ChatMessageInput:
 *       type: object
 *       required:
 *         - role
 *         - content
 *       properties:
 *         role:
 *           type: string
 *           enum: [USER, ASSISTANT, SYSTEM]
 *           example: USER
 *         content:
 *           type: string
 *           example: "Xin chào"
 *         model:
 *           type: string
 *           nullable: true
 *           example: "gemini-2.5-pro"
 *         prompt_tokens:
 *           type: integer
 *           default: 0
 *         completion_tokens:
 *           type: integer
 *           default: 0
 *         total_tokens:
 *           type: integer
 *           default: 0
 *         latency_ms:
 *           type: integer
 *           nullable: true
 *         status:
 *           type: string
 *           enum: [PENDING, COMPLETED, ERROR]
 *           default: COMPLETED
 *     ChatMessageUpdate:
 *       type: object
 *       properties:
 *         role:
 *           type: string
 *           enum: [USER, ASSISTANT, SYSTEM]
 *         content:
 *           type: string
 *         model:
 *           type: string
 *           nullable: true
 *         prompt_tokens:
 *           type: integer
 *         completion_tokens:
 *           type: integer
 *         total_tokens:
 *           type: integer
 *         latency_ms:
 *           type: integer
 *           nullable: true
 *         status:
 *           type: string
 *           enum: [PENDING, COMPLETED, ERROR]
 *     ErrorResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           example: false
 *         message:
 *           type: string
 *           example: "Vui lòng đăng nhập để tiếp tục."
 */

/**
 * @openapi
 * /api/v1/chat:
 *   post:
 *     summary: Gửi câu hỏi đến Chatbot Entity-Driven RAG & Text-to-SQL
 *     description: >
 *       Nhận câu hỏi từ người dùng, xử lý bằng RAG/Text-to-SQL và tự động lưu
 *       2 message vào Project_Chat_Message gồm USER và ASSISTANT. Token được lấy
 *       từ cookie access_token hoặc Authorization Bearer.
 *     tags:
 *       - Chatbot
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [message, project_id]
 *             properties:
 *               project_id:
 *                 type: integer
 *                 description: ID của project để giới hạn phạm vi tìm kiếm.
 *                 example: 12
 *               message:
 *                 type: string
 *                 description: Câu hỏi cần giải đáp hoặc tìm kiếm thông tin khoa học.
 *                 example: "Bài báo nào có lượt trích dẫn cao nhất?"
 *     responses:
 *       200:
 *         description: Phản hồi thành công từ Chatbot
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 answer:
 *                   type: string
 *                   example: "1. **Nature Medicine** - Năm: 2024..."
 *                 messages:
 *                   type: object
 *                   properties:
 *                     user_message_id:
 *                       type: integer
 *                       nullable: true
 *                       example: 101
 *                     assistant_message_id:
 *                       type: integer
 *                       nullable: true
 *                       example: 102
 *       400:
 *         description: Request body không hợp lệ.
 *       401:
 *         description: Chưa đăng nhập hoặc token không hợp lệ.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       429:
 *         description: Vượt quá giới hạn request chat.
 *       500:
 *         description: Lỗi server.
 */

fastify.get('/debug-auth', (req, res) => {
  res.json({
    success: true,
    headers: req.headers,
    cookies: req.headers.cookie || 'No cookies header',
    parsedCookies: req.headers.cookie ? parseCookies(req.headers.cookie) : {},
  });
});

fastify.post('/chat', { preHandler: [requireAuth, chatRateLimiter] }, chatRagSystem);

/**
 * @openapi
 * /api/v1/projects/{projectId}/chat/messages:
 *   post:
 *     summary: Tạo chat message thủ công cho project hiện tại
 *     tags: [Chat Messages]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: integer
 *         example: 12
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ChatMessageInput'
 *     responses:
 *       201:
 *         description: Tạo message thành công.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   $ref: '#/components/schemas/ChatMessage'
 *       401:
 *         description: Chưa đăng nhập hoặc token không hợp lệ.
 *   get:
 *     summary: Lấy lịch sử chat của user hiện tại trong project
 *     tags: [Chat Messages]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: integer
 *         example: 12
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           maximum: 100
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: asc
 *     responses:
 *       200:
 *         description: Lấy lịch sử chat thành công.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ChatMessage'
 *   delete:
 *     summary: Xóa toàn bộ lịch sử chat của user hiện tại trong project
 *     tags: [Chat Messages]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Xóa lịch sử thành công.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 deleted_count:
 *                   type: integer
 *                   example: 10
 */
fastify.post('/projects/:projectId/chat/messages', { preHandler: [requireAuth] }, createChatMessageHandler);
fastify.get('/projects/:projectId/chat/messages', { preHandler: [requireAuth] }, getChatHistory);
fastify.delete('/projects/:projectId/chat/messages', { preHandler: [requireAuth] }, clearChatHistory);

/**
 * @openapi
 * /api/v1/projects/{projectId}/chat/messages/{messageId}:
 *   get:
 *     summary: Lấy chi tiết một chat message
 *     tags: [Chat Messages]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: integer
 *       - in: path
 *         name: messageId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Lấy chi tiết message thành công.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   $ref: '#/components/schemas/ChatMessage'
 *       404:
 *         description: Không tìm thấy message.
 *   patch:
 *     summary: Cập nhật một chat message
 *     tags: [Chat Messages]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: integer
 *       - in: path
 *         name: messageId
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ChatMessageUpdate'
 *     responses:
 *       200:
 *         description: Cập nhật message thành công.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   $ref: '#/components/schemas/ChatMessage'
 *       404:
 *         description: Không tìm thấy message.
 *   delete:
 *     summary: Xóa một chat message
 *     tags: [Chat Messages]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: integer
 *       - in: path
 *         name: messageId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Xóa message thành công.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 deleted_count:
 *                   type: integer
 *                   example: 1
 */
fastify.get('/projects/:projectId/chat/messages/:messageId', { preHandler: [requireAuth] }, getChatMessageDetail);
fastify.patch('/projects/:projectId/chat/messages/:messageId', { preHandler: [requireAuth] }, updateChatMessageHandler);
fastify.delete('/projects/:projectId/chat/messages/:messageId', { preHandler: [requireAuth] }, deleteChatMessageHandler);

}