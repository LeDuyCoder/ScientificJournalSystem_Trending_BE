/**
 * Express controller for analytics endpoints.
 */

import { getPublicationTrends } from '../services/trends.service.js';

/**
 * Return publication and citation trend data for chart rendering.
 *
 * Output shape:
 * { code: 200, message: '...', data: { timeline: [...], series: [...] } }
 *
 * Route: GET /analytics/trends
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function fetchTrends(req, res, next) {
  try {
    const data = await getPublicationTrends();

    res.json({
      code: 200,
      message: 'Fetch publication trends successfully',
      data,
    });
  } catch (err) {
    next(err);
  }
}

