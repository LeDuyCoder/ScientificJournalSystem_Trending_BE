import { searchEntities } from '../services/search/search.service.js';

/**
 * Handle GET /search.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function searchEntitiesHandler(req, res, next) {
  try {
    const data = await searchEntities(req.validatedQuery);

    return res.status(200).json({
      code: 200,
      message: 'Fetch search results successfully',
      data,
    });
  } catch (err) {
    const statusCode = err.code && Number.isInteger(err.code) ? err.code : err.status;
    if (statusCode && statusCode !== 500) {
      return res.status(statusCode).json({
        code: statusCode,
        message: err.message,
        data: null,
      });
    }

    next(err);
  }
}
