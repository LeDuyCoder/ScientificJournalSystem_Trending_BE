import { z } from 'zod';

/**
 * Middleware factory để xác thực request query dựa trên một schema của Zod.
 * @param {z.ZodSchema} schema - Zod schema để xác thực.
 * @returns {import('express').RequestHandler} 
 */
function validateQuery(schema) {
  return (req, reply, done) => {
    try {
      const parsedQuery = schema.parse(req.query);
      req.validatedQuery = parsedQuery;
      if (typeof done === 'function') done();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const payload = {
          code: 400,
          message: 'Validation error',
          errors: error.flatten().fieldErrors,
        };
        if (reply && typeof reply.status === 'function') {
          if (typeof reply.send === 'function') {
            return reply.status(400).send(payload);
          } else if (typeof reply.json === 'function') {
            return reply.status(400).json(payload);
          }
        }
      }
      if (typeof done === 'function') done(error);
      else throw error;
    }
  };
}

// Schema cho GET /articles/search
export const searchArticlesSchema = z.object({
  keyword: z.string()
    .nonempty('Missing query param: keyword')
    .trim()
    .transform(val => decodeURIComponent(val)),
  limit: z.coerce.number().int().positive('limit must be a positive number.').optional().default(50),
});

// Export middleware để sử dụng trong file routes
export const validateSearchArticles = validateQuery(searchArticlesSchema);