import { z } from 'zod';
import { getTopEntities } from '../services/analytics.service.js';
import logger from '../../utils/logger.js';

const getTopEntitiesSchema = z.object({
  project_id: z.string().min(1, 'project_id is required'),
  entity_type: z.enum(['institution', 'university', 'research_center']).optional(),
  from_year: z.coerce.number().int().optional(),
  to_year: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().positive().max(50).optional().default(10)
});

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
        message: 'Invalid year range: from_year cannot be greater than to_year'
      });
    }

    const filters = {
      projectId: query.project_id,
      entityType: query.entity_type,
      fromYear: query.from_year,
      toYear: query.to_year,
      limit: query.limit
    };

    const data = await getTopEntities(filters);

    res.status(200).json({
      code: 200,
      message: 'Fetch top entities successfully',
      data
    });
  } catch (error) {
    logger.error('Error in getTopEntitiesHandler:', error);
    next(error);
  }
}