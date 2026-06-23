import express from 'express';

import { fetchTrends } from '../controller/analytics.controller.js';

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

export default router;




