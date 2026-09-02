

import { searchArticles } from './articles.controller.js';
import { validateSearchArticles } from './articles.validator.js';

export default async function (fastify, opts) {

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
 */fastify.get('/search', { preHandler: [validateSearchArticles] }, searchArticles);

}
