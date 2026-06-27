/**
 * Express controller for analytics endpoints.
 */
import logger from '../utils/logger.js';
import { getTopEntities } from '../services/analytics.service.js';
import { getPublicationTrends } from '../services/trends.service.js';
import { getFrontierTopics } from '../services/frontier.service.js';
import { getDistribution } from '../services/distribution.service.js';
import { getForecastInsights } from '../services/forecast.service.js';
import { getGeoDistribution } from '../services/geoDistribution.service.js';
import { getJournalQuartileDistribution } from '../services/journal-quartile.service.js';

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
 * Handler for GET /analytics/journals/quartiles
 * Fetches and returns the Scimago quartile distribution for journals within a project's scope.
 *
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express next middleware function.
 */
export async function fetchJournalQuartileDistribution(req, res, next) {
  try {
    const { project_id, subject_area, keywords, from_year, to_year } = req.validatedQuery;

    const data = await getJournalQuartileDistribution({
      projectId: String(project_id),
      subjectArea: subject_area ? String(subject_area) : undefined,
      keywords: keywords ? String(keywords) : undefined,
      fromYear: from_year,
      toYear: to_year,
    });

    res.json({ code: 200, message: 'Fetch quartile distribution successfully', data });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ code: err.status, message: err.message, data: null });
    }
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
    const { project_id, entity_type, from_year, to_year, limit } = req.validatedQuery;

    const filters = {
      projectId: project_id,
      entityType: entity_type,
      fromYear: from_year,
      toYear: to_year,
      limit: limit,
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
    const filters = req.validatedQuery;
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
    const { project_id, distribution_type, subject_area, keywords, from_year, to_year } = req.validatedQuery;

    const data = await getDistribution({ project_id, distribution_type, subject_area, keywords, from_year, to_year });

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
    const { project_id } = req.validatedQuery;

    const data = await getForecastInsights(project_id);

    return res.json({
      code: 200,
      message: 'Fetch forecast insights successfully',
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
    const { project_id, subject_area, keywords, from_year, to_year } = req.validatedQuery;

    const filters = {
      subjectArea: subject_area,
      keywords: keywords,
      fromYear: from_year,
      toYear: to_year,
    };

    const data = await getGeoDistribution(project_id, filters);

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
