/**
 * Express controller for analytics endpoints.
 */

import { z } from 'zod';
import logger from '../../utils/logger.js';
import { getTopEntities } from '../services/analytics.service.js';
import { getPublicationTrends } from '../services/trends.service.js';
import { getFrontierTopics } from '../services/frontier.service.js';
import { getForecastInsights } from '../services/forecast.service.js';
import { getGeoDistribution } from '../services/geoDistribution.service.js';
import { getImpactQuartiles } from '../services/impactQuartiles.service.js';

const getTopEntitiesSchema = z.object({
  project_id: z.string().min(1, 'project_id is required'),
  entity_type: z
    .enum(['institution', 'university', 'research_center'])
    .optional(),
  from_year: z.coerce.number().int().optional(),
  to_year: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().positive().max(50).optional().default(10),
});

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
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export async function getTopEntitiesHandler(req, res, next) {
  try {
    const query = getTopEntitiesSchema.parse(req.query);

    if (query.from_year && query.to_year && query.from_year > query.to_year) {
      return res.status(400).json({
        code: 400,
        message: 'Invalid year range: from_year cannot be greater than to_year',
      });
    }

    const filters = {
      projectId: query.project_id,
      entityType: query.entity_type,
      fromYear: query.from_year,
      toYear: query.to_year,
      limit: query.limit,
    };

    const data = await getTopEntities(filters);

    res.status(200).json({
      code: 200,
      message: 'Fetch top entities successfully',
      data,
    });
  } catch (error) {
    logger.error('Error in getTopEntitiesHandler:', error);
    next(error);
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

/**
 * Return geographical research distribution metrics for a project.
 *
 * Route: GET /analytics/geo-distribution
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function fetchGeoDistribution(req, res, next) {
  try {
    const projectId = req.query.project_id;

    if (!projectId) {
      return res.status(400).json({
        code: 400,
        message: 'project_id is required',
        data: null,
      });
    }

    const fromYear = req.query.from_year ? Number(req.query.from_year) : undefined;
    const toYear = req.query.to_year ? Number(req.query.to_year) : undefined;

    if (fromYear !== undefined && toYear !== undefined && fromYear > toYear) {
      return res.status(400).json({
        code: 400,
        message: 'Invalid year range',
        data: null,
      });
    }

    const filters = {
      subjectArea: req.query.subject_area ? String(req.query.subject_area).trim() : undefined,
      keywords: req.query.keywords || req.query.keyword,
      fromYear,
      toYear,
    };

    const data = await getGeoDistribution(projectId, filters);

    return res.json({
      code: 200,
      message: 'Fetch geographical metrics successfully',
      data,
    });
  } catch (err) {
    const statusCode = err.code && Number.isInteger(err.code) ? err.code : 500;
    if (statusCode !== 500) {
      return res.status(statusCode).json({
        code: statusCode,
        message: err.message,
        data: null,
      });
    }
    next(err);
  }
}

/**
 * Return impact quartile summary metric for a project.
 *
 * Route: GET /analytics/impact-quartiles
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function fetchImpactQuartiles(req, res, next) {
  try {
    const projectId = req.query.project_id;

    if (!projectId) {
      return res.status(400).json({
        code: 400,
        message: 'project_id is required',
        data: null,
      });
    }

    const fromYear = req.query.from_year ? Number(req.query.from_year) : undefined;
    const toYear = req.query.to_year ? Number(req.query.to_year) : undefined;

    if (fromYear !== undefined && toYear !== undefined && fromYear > toYear) {
      return res.status(400).json({
        code: 400,
        message: 'Invalid year range',
        data: null,
      });
    }

    const filters = {
      subjectArea: req.query.subject_area ? String(req.query.subject_area).trim() : undefined,
      keywords: req.query.keywords || req.query.keyword,
      fromYear,
      toYear,
    };

    const data = await getImpactQuartiles(projectId, filters);

    return res.json({
      code: 200,
      message: 'Fetch impact quartile summary successfully',
      data,
    });
  } catch (err) {
    const statusCode = err.code && Number.isInteger(err.code) ? err.code : 500;
    if (statusCode !== 500) {
      return res.status(statusCode).json({
        code: statusCode,
        message: err.message,
        data: null,
      });
    }
    next(err);
  }
}
