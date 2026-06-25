import express from 'express';

import { fetchTrends, fetchFrontier } from '../controller/analytics.controller.js';

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

export default router;




