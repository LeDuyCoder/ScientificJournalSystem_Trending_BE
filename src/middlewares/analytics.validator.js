import { z } from 'zod';

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
 * Middleware factory để xác thực request query dựa trên một schema của Zod.
 * @param {z.ZodSchema} schema - Zod schema để xác thực.
 * @returns {import('express').RequestHandler}
 */
export function validateQuery(schema) {
  return (req, res, next) => {
    try {
      // Phân tích và xác thực req.query
      const parsedQuery = schema.parse(req.query);
      // Gán lại query đã được xác thực và chuyển đổi vào req.validatedQuery
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

// Schema chung cho các bộ lọc có thể tái sử dụng
const commonFiltersSchema = {
  subject_area: z.string().optional(),
  keywords: z.preprocess(
    (val) => parseFilterArray(val),
    z.array(z.union([z.string(), z.number()])).optional()
  ),
  from_year: z.coerce.number().int().optional(),
  to_year: z.coerce.number().int().optional(),
};

const yearRangeRefinement = (data) => !data.from_year || !data.to_year || data.from_year <= data.to_year;
const yearRangeMessage = {
  message: 'Invalid year range: from_year cannot be greater than to_year',
  path: ['from_year', 'to_year'],
};

// Schema cho /analytics/top-entities
export const getTopEntitiesSchema = z.object({
  project_id: z.string().min(1, 'project_id is required'),
  entity_type: z.enum(['institution', 'university', 'research_center']).optional(),
  from_year: z.coerce.number().int().optional(),
  to_year: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().positive().max(50).optional().default(10),
}).refine(yearRangeRefinement, yearRangeMessage);

// Schema cho /analytics/journals/quartiles
export const getJournalQuartileSchema = z.object({
  project_id: z.string().min(1, 'project_id is required'),
  ...commonFiltersSchema
}).refine(yearRangeRefinement, yearRangeMessage);

// Schema cho /analytics/frontier
export const getFrontierSchema = z.object({
  subjectArea: z.string().optional(),
  keywords: z.preprocess(
    (val) => parseFilterArray(val),
    z.array(z.union([z.string(), z.number()])).optional()
  ),
});

// Schema cho /analytics/distribution
export const getDistributionSchema = z.object({
  project_id: z.string().optional(),
  distribution_type: z.enum(['sector', 'impact_quartile']).default('sector'),
  ...commonFiltersSchema
}).refine(yearRangeRefinement, yearRangeMessage);

// Schema cho /analytics/forecast
export const getForecastSchema = z.object({
  project_id: z.string().min(1, 'project_id is required'),
});

// Schema cho /analytics/geo-distribution
export const getGeoDistributionSchema = z.object({
  project_id: z.string().min(1, 'project_id is required'),
  ...commonFiltersSchema
}).refine(yearRangeRefinement, yearRangeMessage);

// Schema cho /analytics/impact-quartiles
export const getImpactQuartilesSchema = z.object({
  project_id: z.string().min(1, 'project_id is required'),
  ...commonFiltersSchema
}).refine(yearRangeRefinement, yearRangeMessage);

/**
 * Middleware để chuẩn bị các bộ lọc cho `fetchFrontier`.
 * Nó xử lý nhiều tên query param cho keywords.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function prepareFrontierFilters(req, res, next) {
  try {
    const query = {
      subjectArea: req.query.subjectArea,
      keywords: req.query.keywords || req.query.keyword || req.query.keywordIds || req.query.keywordId,
    };
    req.validatedQuery = getFrontierSchema.parse(query);
    next();
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        code: 400,
        message: 'Validation error',
        errors: error.flatten().fieldErrors,
      });
    }
    next(error);
  }
}