import express from 'express';

import { searchArticles } from '../controller/articles.controller.js';
import { validateSearchArticles } from '../middlewares/articles.validator.js';
const router = express.Router();

/**
 * Search articles in Neo4j by keyword and return nodes + relationships (r:REFERENCES).
 *
 * @openapi
 * /articles/search:
 *   get:
 *     summary: Search articles by keyword
 *     tags:
 *       - Articles
 *     parameters:
 *       - in: query
 *         name: keyword
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Search results
 */
router.get('/search', validateSearchArticles, searchArticles);

export default router;
