/**
 * Express controller for analytics endpoints.
 */

import { getPublicationTrends } from '../services/trends.service.js';
import { getFrontierTopics } from '../services/frontier.service.js';
import { getDistribution } from '../services/distribution.service.js';

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
 * Fetch research landscape and impact quartile distribution.
 *
 * Route: GET /analytics/distribution
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function fetchDistribution(req, res, next) {
  try {
    const { project_id, distribution_type, subject_area, keywords, from_year, to_year } = req.query;

    if (!project_id) {
      return res.status(400).json({
        code: 400,
        message: 'Missing project_id',
        data: null
      });
    }

    if (distribution_type && !['sector', 'impact_quartile'].includes(distribution_type)) {
      return res.status(400).json({
        code: 400,
        message: 'Invalid distribution type',
        data: null
      });
    }

    const options = {
      project_id: String(project_id).trim(),
      distribution_type: distribution_type ? String(distribution_type).trim() : 'sector',
      subject_area: subject_area ? String(subject_area).trim() : undefined,
      keywords: parseFilterArray(keywords),
      from_year: from_year ? Number(from_year) : undefined,
      to_year: to_year ? Number(to_year) : undefined,
    };

    if (options.from_year && options.to_year && options.from_year > options.to_year) {
      return res.status(400).json({
        code: 400,
        message: 'Invalid year range',
        data: null
      });
    }

    const data = await getDistribution(options);

    res.json({
      code: 200,
      message: 'Fetch distribution successfully',
      data,
    });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({
        code: 404,
        message: err.message,
        data: null
      });
    }
    next(err);
  }
}

