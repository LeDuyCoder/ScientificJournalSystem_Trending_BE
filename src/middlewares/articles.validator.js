import { z } from 'zod';

/**
 * Middleware factory để xác thực request query dựa trên một schema của Zod.
 * @param {z.ZodSchema} schema - Zod schema để xác thực.
 * @returns {import('express').RequestHandler}
 */
function validateQuery(schema) {
  return (req, res, next) => {
    try {
      // Phân tích và xác thực req.query
      const parsedQuery = schema.parse(req.query);
      // Gán query đã được xác thực và chuyển đổi vào req.validatedQuery
      // để controller có thể sử dụng một cách an toàn.
      req.validatedQuery = parsedQuery;
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          code: 400,
          message: 'Validation error',
          errors: error.flatten().fieldErrors,
        });
      }
      // Chuyển các lỗi khác cho error handler chung
      next(error);
    }
  };
}

// Schema cho GET /articles/search
export const searchArticlesSchema = z.object({
  keyword: z.string()
    .trim()
    .min(1, 'keyword query parameter is required and cannot be empty.')
    .transform(val => decodeURIComponent(val)),
  limit: z.coerce.number().int().positive('limit must be a positive number.').optional(),
});

// Export middleware để sử dụng trong file routes
export const validateSearchArticles = validateQuery(searchArticlesSchema);