import { z } from 'zod';
import { validateQuery } from './analytics.validator.js';

const yearRangeRefinement = (data) => !data.from_year || !data.to_year || data.from_year <= data.to_year;

export const searchEntitiesSchema = z.object({
  q: z.string({ required_error: 'q is required' })
    .trim()
    .min(2, 'q must be at least 2 characters')
    .max(200, 'q must be at most 200 characters'),
  type: z.enum(['all', 'article', 'journal', 'author', 'institution', 'keyword', 'topic']).optional().default('all'),
  project_id: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(50).optional().default(10),
  from_year: z.coerce.number().int().optional(),
  to_year: z.coerce.number().int().optional(),
  sort: z.enum(['relevance', 'year_desc', 'citations_desc', 'name_asc']).optional().default('relevance'),
}).refine(yearRangeRefinement, {
  message: 'Invalid year range: from_year cannot be greater than to_year',
  path: ['from_year', 'to_year'],
});

export const validateSearchEntities = validateQuery(searchEntitiesSchema);
