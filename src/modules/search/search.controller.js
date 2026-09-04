import { searchEntities } from './services/search/search.service.js';

/**
 * Handle GET /search.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function searchEntitiesHandler(request, reply) {
  try {
    const data = await searchEntities(request.query);

    return reply.status(200).send({
      code: 200,
      message: 'Fetch search results successfully',
      data,
    });
  } catch (err) {
    const statusCode = err.code && Number.isInteger(err.code) ? err.code : err.status;
    if (statusCode && statusCode !== 500) {
      return reply.status(statusCode).send({
        code: statusCode,
        message: err.message,
        data: null,
      });
    }

    throw err;
  }
}
