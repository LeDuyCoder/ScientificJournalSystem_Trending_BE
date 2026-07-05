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
 *               - project_id
 *             properties:
 *               project_id:
 *                 type: integer
 *                 description: ID của project để giới hạn phạm vi tìm kiếm.
 *                 example: 12
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
 *                 answer:
 *                   type: string
 *                   description: Câu trả lời dạng text Markdown sạch, phù hợp để hiển thị trực tiếp trên giao diện chat.
 *                   example: "1. **Nature Medicine** - Năm: 2024 - Phân nhóm: Q1 - Chỉ số: SJR"
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