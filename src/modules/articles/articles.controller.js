/**
 * Express controller for article-related endpoints.
 */

import { searchArticlesByKeyword } from '../search/services/search/graph.service.js';

/**
 * Search ARTICLE nodes by keyword and return nodes + `REFERENCES` relationships.
 *
 * Output shape:
 * { source: 'neo4j', nodes: [...], relationships: [...] }
 *
 * Route: GET /articles/search?keyword=...&limit=...
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function searchArticles(request, reply) {
  try {
    const { keyword, limit } = request.query;

    const data = await searchArticlesByKeyword(keyword, {
      limit: limit,
    });

    reply.send({
      code: 200,
      message: 'Search articles graph completed successfully',
      data,
    });
  } catch (err) {
    throw err;
  }
}
