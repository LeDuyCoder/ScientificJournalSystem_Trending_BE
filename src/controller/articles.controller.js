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
    const rawKeyword = req.query.keyword;

    const keyword = rawKeyword
      ? decodeURIComponent(String(rawKeyword)).trim()
      : '';

    const limitRaw = req.query.limit;

    if (!keyword || typeof keyword !== 'string') {
      res.status(400).json({ message: 'Missing query param: keyword' });
      return;
    }

    const limit = limitRaw ? Number(limitRaw) : undefined;

    const data = await searchArticlesByKeyword(keyword, {
      limit: Number.isFinite(limit) ? limit : undefined,
    });

    res.json({
      source: 'neo4j',
      ...data,
    });
  } catch (err) {
    next(err);
  }
}




