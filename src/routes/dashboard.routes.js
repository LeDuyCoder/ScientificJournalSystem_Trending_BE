import express from 'express';
import { getDashboardStatsHandler } from '../controller/dashboard.controller.js';

// Khởi tạo router của Express cho các endpoint liên quan đến dashboard
const router = express.Router();

/**
 * Định nghĩa tài liệu Swagger OpenAPI cho endpoint lấy số liệu thống kê Dashboard.
 * 
 * @openapi
 * /dashboard/stats:
 *   get:
 *     summary: Lấy dữ liệu thống kê tổng quan của dashboard
 *     description: >
 *       Trả về tổng số lượng và tốc độ tăng trưởng của các thực thể bao gồm:
 *       Bài báo khoa học (Articles), Tạp chí khoa học (Journals), Tác giả (Authors), và Lượt trích dẫn (Citations).
 *       Dữ liệu phản hồi được lưu tạm thời (caching) trong Redis trong vòng 5 phút để tăng tốc độ phản hồi.
 *     tags:
 *       - Dashboard
 *     parameters:
 *       - in: query
 *         name: project_id
 *         schema:
 *           type: string
 *         description: 'ID của project để lọc dữ liệu thống kê theo phạm vi của project đó.'
 *     responses:
 *       200:
 *         description: Lấy dữ liệu thống kê thành công
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
 *                   example: Fetch dashboard statistics successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     totalAuthors:
 *                       $ref: '#/components/schemas/StatMetric'
 *                     totalJournals:
 *                       $ref: '#/components/schemas/StatMetric'
 *                     densityIndex:
 *                       $ref: '#/components/schemas/DensityMetric'
 *                     totalRelocated:
 *                       $ref: '#/components/schemas/StatMetric'
 *       500:
 *         description: Lỗi máy chủ nội bộ
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Internal Server Error
 */
router.get('/stats', getDashboardStatsHandler);

export default router;