import express from 'express';
import { getTopEntitiesHandler } from '../controller/analytics.controller.js';

const router = express.Router();

/**
 * @openapi
 * /analytics/top-entities:
 *   get:
 *     summary: Lấy danh sách các tổ chức/viện nghiên cứu hàng đầu
 *     description: >
 *       Trả về danh sách các tổ chức được xếp hạng dựa trên một điểm số tổng hợp (số lượng bài báo, trích dẫn, H-index...).
 *       API yêu cầu `project_id` để xác định phạm vi phân tích (lĩnh vực, từ khóa) mà project đang theo dõi.
 *     tags:
 *       - Analytics
 *     parameters:
 *       - in: query
 *         name: project_id
 *         schema:
 *           type: string
 *         required: true
 *         description: 'ID của project để xác định phạm vi phân tích.'
 *       - in: query
 *         name: entity_type
 *         schema:
 *           type: string
 *           enum: [institution, university, research_center]
 *         description: 'Loại tổ chức cần xếp hạng. Mặc định là "institution".'
 *       - in: query
 *         name: from_year
 *         schema:
 *           type: integer
 *         description: 'Năm bắt đầu lọc dữ liệu.'
 *       - in: query
 *         name: to_year
 *         schema:
 *           type: integer
 *         description: 'Năm kết thúc lọc dữ liệu.'
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: 'Số lượng kết quả trả về. Mặc định là 10.'
 *     responses:
 *       200:
 *         description: Lấy dữ liệu thành công.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: Fetch top entities successfully
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/TopEntity'
 */
router.get('/top-entities', getTopEntitiesHandler);

export default router;