/**
 * Express controller for article-related endpoints.
 */

import { searchArticlesByKeyword } from '../services/graph.service.js';

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
export async function searchArticles(req, res, next) {
  try {
    // Lấy dữ liệu đã được xác thực và chuẩn hóa từ middleware
    const { keyword, limit } = req.validatedQuery;

    const data = await searchArticlesByKeyword(keyword, {
      limit: limit,
    });

    res.json({
      source: 'neo4j',
      ...data,
    });
  } catch (err) {
    next(err);
  }
}
