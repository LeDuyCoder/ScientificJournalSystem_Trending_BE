import express from 'express';
import { chatRagSystem } from '../controller/chat.controller.js';

const router = express.Router();

/**
 * @openapi
 * /api/v1/chat:
 *   post:
 *     summary: Gửi câu hỏi đến Chatbot Entity-Driven RAG & Text-to-SQL
 *     description: >
 *       Nhận câu hỏi từ người dùng bằng tiếng Việt, phân tích thực thể và ý định (Intent Routing),
 *       tự động chuyển đổi thành câu lệnh SQL để truy vấn CSDL PostgreSQL hoặc tìm kiếm ngữ nghĩa
 *       sử dụng pgvector, sau đó tổng hợp câu trả lời cuối cùng bằng tiếng Việt từ ngữ cảnh nhận được thông qua mô hình ngôn ngữ Ollama.
 *     tags:
 *       - Chatbot
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - message
 *             properties:
 *               message:
 *                 type: string
 *                 description: Câu hỏi cần giải đáp hoặc tìm kiếm thông tin khoa học.
 *                 example: "Danh sách các tạp chí xếp hạng Q1 năm 2024"
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
 *                 routeDecision:
 *                   type: object
 *                   properties:
 *                     route:
 *                       type: string
 *                       example: "RANKING_SQL"
 *                     primary_entity:
 *                       type: string
 *                       example: "Journal"
 *                     intent_type:
 *                       type: string
 *                       example: "quartile_lookup"
 *                     required_tables:
 *                       type: array
 *                       items:
 *                         type: string
 *                       example: ["Journal", "Journal_Ranking"]
 *                     reason:
 *                       type: string
 *                       example: "User is asking about Q1 journals in 2024"
 *                 toolResult:
 *                   type: object
 *                   properties:
 *                     type:
 *                       type: string
 *                       example: "RANKING_SQL"
 *                     sql:
 *                       type: string
 *                       example: "SELECT j.journal_id, j.display_name AS journal_name, jr.year, jr.value_txt FROM \"Journal\" AS j JOIN \"Journal_Ranking\" AS jr ON jr.journal_id = j.journal_id WHERE jr.year = 2024 AND jr.value_txt ILIKE '%Q1%' AND j.is_deleted = false LIMIT 20"
 *                     rows:
 *                       type: array
 *                       items:
 *                         type: object
 *                     error:
 *                       type: string
 *                       nullable: true
 *                       example: null
 *                 answer:
 *                   type: string
 *                   description: Câu trả lời cuối cùng bằng tiếng Việt đã được tổng hợp từ ngữ cảnh dữ liệu.
 *                   example: "Dưới đây là danh sách các tạp chí Q1 năm 2024 nhận được từ cơ sở dữ liệu..."
 *       400:
 *         description: Yêu cầu không hợp lệ do thiếu tham số 'message' trong body.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Message is required"
 *       500:
 *         description: Lỗi máy chủ nội bộ hoặc hết hạn kết nối tới dịch vụ LLM.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Đã xảy ra lỗi hệ thống, vui lòng thử lại sau."
 */
router.post('/chat', chatRagSystem);

export default router;