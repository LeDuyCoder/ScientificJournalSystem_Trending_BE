import express from 'express';

import {
  fetchTrends,
  fetchFrontier,
  fetchForecast,
  getTopEntitiesHandler,
} from '../controller/analytics.controller.js';

const router = express.Router();

/**
 * Get publication & citation historical trends for chart rendering.
 *
 * @openapi
 * /analytics/trends:
 *   get:
 *     summary: Get publication & citation historical trends
 *     tags:
 *       - Analytics
 *     responses:
 *       200:
 *         description: Trend data returned successfully
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
 *                   example: Fetch publication trends successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     timeline:
 *                       type: array
 *                       items:
 *                         type: string
 *                       example: ["2021", "2022", "2023", "2024", "2025", "2026"]
 *                     series:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           name:
 *                             type: string
 *                             example: Articles
 *                           data:
 *                             type: array
 *                             items:
 *                               type: integer
 *                             example: [12000, 15000, 18500, 22000, 28000, 32950]
 */
router.get('/trends', fetchTrends);

/**
 * Get emerging and frontier tech topics based on Impact vs Velocity.
 *
 * @openapi
 * /analytics/frontier:
 *   get:
 *     summary: Get frontier technology topics
 *     description: Returns emerging and frontier technology topics categorized by Impact vs Citation Velocity, suitable for bubble chart visualization.
 *     tags:
 *       - Analytics
 *     parameters:
 *       - in: query
 *         name: subjectArea
 *         schema:
 *           type: string
 *         description: 'Tên lĩnh vực chính của dự án để lọc dữ liệu (ví dụ: Computer Science).'
 *       - in: query
 *         name: keywords
 *         schema:
 *           type: string
 *         description: 'Danh sách tên hoặc ID Keyword ngăn cách bởi dấu phẩy để lọc dữ liệu (ví dụ: AI Agent,Machine Learning).'
 *       - in: query
 *         name: keywordIds
 *         schema:
 *           type: string
 *         description: '(Tùy chọn khác) Danh sách ID hoặc tên Keyword ngăn cách bởi dấu phẩy để lọc dữ liệu.'
 *     responses:
 *       200:
 *         description: Frontier topics returned successfully
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
 *                   example: Fetch frontier topics successfully
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       topic:
 *                         type: string
 *                         example: Gen AI
 *                       impactFactor:
 *                         type: number
 *                         format: float
 *                         example: 2.4
 *                       citationVelocity:
 *                         type: number
 *                         format: float
 *                         example: 4.5
 *                       status:
 *                         type: string
 *                         enum: [EMERGING, FRONTIER]
 *                         example: EMERGING
 *       500:
 *         description: Internal Server Error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Internal Server Error
 */
router.get('/frontier', fetchFrontier);

/**
 * @openapi
 * /analytics/forecast:
 *   get:
 *     summary: Get forecast insights for a project
 *     description: |
 *       Returns three blocks of insights (PEAK, ALERT, SYNERGY) for a given project,
 *       based on an analysis of its associated subject categories against global data.
 *     tags:
 *       - Analytics
 *     parameters:
 *       - in: query
 *         name: project_id
 *         schema:
 *           type: integer
 *         required: true
 *         description: The ID of the project for which to generate forecast insights.
 *     responses:
 *       200:
 *         description: Forecast insights returned successfully.
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
 *                   example: Fetch forecast insights successfully
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       type:
 *                         type: string
 *                         enum: [PEAK, ALERT, SYNERGY]
 *                         example: PEAK
 *                       title:
 *                         type: string
 *                         example: Predictive Peak
 *                       content:
 *                         type: string
 *                         example: "Bio-engineering is projected to reach its citation apex in Q3 2027..."
 *       400:
 *         description: Bad Request - project_id is missing.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: integer
 *                   example: 400
 *                 message:
 *                   type: string
 *                   example: project_id is required
 *                 data:
 *                   type: object
 *                   nullable: true
 *                   example: null
 *       404:
 *         description: Not Found - Project or its subject categories could not be found.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: integer
 *                   example: 404
 *                 message:
 *                   type: string
 *                   example: "Project not found"
 *                 data:
 *                   type: object
 *                   nullable: true
 *                   example: null
 */
router.get('/forecast', fetchForecast);

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
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                         example: "Stanford University"
 *                       score:
 *                         type: number
 *                         example: 94.2
 */
router.get('/top-entities', getTopEntitiesHandler);

export default router;
