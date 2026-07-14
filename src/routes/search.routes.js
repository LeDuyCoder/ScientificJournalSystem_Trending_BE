import express from 'express';

import { searchEntitiesHandler } from '../controller/search.controller.js';
import { validateSearchEntities } from '../middlewares/search.validator.js';

const router = express.Router();

/**
 * Search articles, journals, authors and related research entities.
 *
 * @openapi
 * /search:
 *   get:
 *     summary: Search articles, journals, authors, institutions, keywords and topics
 *     tags:
 *       - Search
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *           minLength: 2
 *         description: Search keyword.
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           default: all
 *           enum: [all, article, journal, author, institution, keyword, topic]
 *         description: Entity type to search.
 *       - in: query
 *         name: project_id
 *         schema:
 *           type: string
 *         description: Optional project ID to limit results to a project scope.
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *           minimum: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *           minimum: 1
 *           maximum: 50
 *       - in: query
 *         name: from_year
 *         schema:
 *           type: integer
 *         description: Filter article-linked results from this publication year.
 *       - in: query
 *         name: to_year
 *         schema:
 *           type: integer
 *         description: Filter article-linked results up to this publication year.
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *           default: relevance
 *           enum: [relevance, year_desc, citations_desc, name_asc]
 *     responses:
 *       200:
 *         description: Search results returned successfully.
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
 *                   example: Fetch search results successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     query:
 *                       type: string
 *                       example: machine learning
 *                     type:
 *                       type: string
 *                       example: all
 *                     page:
 *                       type: integer
 *                       example: 1
 *                     limit:
 *                       type: integer
 *                       example: 10
 *                     total:
 *                       type: integer
 *                       example: 128
 *                     totalPages:
 *                       type: integer
 *                       example: 13
 *                     counts:
 *                       type: object
 *                       additionalProperties:
 *                         type: integer
 *                     items:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                             example: "123"
 *                           rank:
 *                             type: integer
 *                             example: 1
 *                           type:
 *                             type: string
 *                             example: article
 *                           typeLabel:
 *                             type: string
 *                             example: Bài báo
 *                           typeIcon:
 *                             type: string
 *                             example: file-text
 *                           title:
 *                             type: string
 *                             example: Machine Learning in Scientific Discovery
 *                           subtitle:
 *                             type: string
 *                             nullable: true
 *                             example: Ada Lovelace | Nature Machine Intelligence | 2025
 *                           description:
 *                             type: string
 *                             nullable: true
 *                           snippet:
 *                             type: string
 *                             nullable: true
 *                             example: Short summary or abstract snippet for displaying inside a result card.
 *                           imageUrl:
 *                             type: string
 *                             nullable: true
 *                             example: https://example.com/avatar.png
 *                           detailPath:
 *                             type: string
 *                             example: /articles/123
 *                           publicationYear:
 *                             type: integer
 *                             nullable: true
 *                             example: 2025
 *                           citationCount:
 *                             type: integer
 *                             example: 42
 *                           score:
 *                             type: integer
 *                             example: 85
 *                           badges:
 *                             type: array
 *                             items:
 *                               type: object
 *                               properties:
 *                                 label:
 *                                   type: string
 *                                   example: Journal
 *                                 value:
 *                                   type: string
 *                                   example: Nature
 *                                 variant:
 *                                   type: string
 *                                   example: neutral
 *                           stats:
 *                             type: array
 *                             items:
 *                               type: object
 *                               properties:
 *                                 label:
 *                                   type: string
 *                                   example: Citations
 *                                 value:
 *                                   oneOf:
 *                                     - type: number
 *                                     - type: string
 *                                   example: 42
 *                                 displayValue:
 *                                   type: string
 *                                   example: 42
 *                                 suffix:
 *                                   type: string
 *                                   nullable: true
 *                           metadata:
 *                             type: object
 *       400:
 *         description: Validation error.
 *       404:
 *         description: Project not found.
 */
router.get('/', validateSearchEntities, searchEntitiesHandler);

export default router;
