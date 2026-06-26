/**
 * Express controller for analytics endpoints.
 */

import { getPublicationTrends } from '../services/trends.service.js';
import { getFrontierTopics } from '../services/frontier.service.js';
import { getForecastInsights } from '../services/forecast.service.js';

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

/**
 * Hàm hỗ trợ phân tích query parameter thành mảng các chuỗi/số sạch.
 * @param {any} val - Giá trị query parameter.
 * @returns {Array<string|number>}
 */
function parseFilterArray(val) {
  if (!val) return [];
  const raw = Array.isArray(val)
    ? val
    : String(val).split(',').map(v => v.trim());
  
  return raw
    .map(v => {
      const num = Number(v);
      return !Number.isNaN(num) && String(num) === String(v) ? num : v;
    })
    .filter(v => v !== '');
}

/**
 * Return frontier technology topics based on Impact vs Velocity.
 *
 * Output shape:
 * { code: 200, message: '...', data: [...] }
 *
 * Route: GET /analytics/frontier
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function fetchFrontier(req, res, next) {
  try {
    const filters = {
      subjectArea: req.query.subjectArea ? String(req.query.subjectArea).trim() : '',
      keywords: parseFilterArray(req.query.keywords || req.query.keyword || req.query.keywordIds || req.query.keywordId),
    };

    const data = await getFrontierTopics(filters);

    res.json({
      code: 200,
      message: 'Fetch frontier topics successfully',
      data,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Returns forecast insights (PEAK, ALERT, SYNERGY) for a given project.
 *
 * Route: GET /analytics/forecast
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function fetchForecast(req, res, next) {
  try {
    const projectId = req.query.project_id;

    if (!projectId) {
      return res.status(400).json({
        code: 400,
        message: 'project_id is required',
        data: null,
      });
    }

    const data = await getForecastInsights(projectId);

    return res.json({
      code: 200,
      message: 'Fetch forecast insights successfully',
      data,
    });
  } catch (err) {
    // The service layer should throw errors with a `code` property (e.g., 404)
    const statusCode = err.code && Number.isInteger(err.code) ? err.code : 500;
    if (statusCode !== 500) {
       return res.status(statusCode).json({
        code: statusCode,
        message: err.message,
        data: null,
      });
    }
    // For unhandled/unexpected errors, let the generic error handler deal with it.
    next(err);
  }
}

