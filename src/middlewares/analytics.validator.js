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
          errors: error.flatten().fieldErrors, // Giữ nguyên format lỗi hiện tại
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
  keywords: z.string().optional(), // Sẽ được service xử lý split(',')
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
  project_id: z.string({ required_error: 'project_id is required' }).min(1, 'project_id is required'),
  ...commonFiltersSchema
}).refine(yearRangeRefinement, yearRangeMessage);

// Schema cho /analytics/journals/impact-matrix
export const getImpactMatrixSchema = z.object({
  project_id: z.string({ required_error: 'project_id is required' }).min(1, 'project_id is required'),
  limit: z.coerce.number().int().positive().max(100).optional().default(50),
  ...commonFiltersSchema
}).refine(yearRangeRefinement, yearRangeMessage);

// Schema cho /analytics/frontier
export const getFrontierSchema = z.object({
  subjectArea: z.string().trim().optional(),
  keywords: z.preprocess(
    // Hợp nhất nhiều query param có thể có cho keywords
    (val) => val?.keywords || val?.keyword || val?.keywordIds || val?.keywordId,
    z.union([z.string(), z.array(z.string())]).optional()
  ),
});

// Schema cho /analytics/distribution
export const getDistributionSchema = z.object({
  project_id: z.string().optional(),
  distribution_type: z.enum(['sector', 'impact_quartile']).default('sector'),
  ...commonFiltersSchema
}).refine(yearRangeRefinement, yearRangeMessage);;

// Schema cho /analytics/forecast
export const getForecastSchema = z.object({
  project_id: z.string({ required_error: 'project_id is required' }).min(1, 'project_id is required'),
});

// Schema cho /analytics/geo-distribution
export const getGeoDistributionSchema = z.object({
  project_id: z.string().min(1, 'project_id is required'),
  ...commonFiltersSchema
}).refine(yearRangeRefinement, yearRangeMessage);

// Schema cho /analytics/impact-quartiles
export const getImpactQuartilesSchema = z.object({
  project_id: z.string({ required_error: 'project_id is required' }).min(1, 'project_id is required'),
  ...commonFiltersSchema
}).refine(yearRangeRefinement, yearRangeMessage);

// Schema cho /analytics/trends
export const getTrendsSchema = z.object({
  project_id: z.string().optional(),
  ...commonFiltersSchema
}).refine(yearRangeRefinement, yearRangeMessage);

// Schema cho /analytics/journals/ranking
export const getJournalRankingSchema = z.object({
  project_id: z.string({ required_error: 'project_id is required' }).min(1, 'project_id is required'),
  limit: z.coerce.number().int().positive().min(1).max(50).default(5),
  ...commonFiltersSchema
}).refine(yearRangeRefinement, yearRangeMessage);

// Schema cho /analytics/network/collaboration
export const getCollaborationNetworkSchema = z.object({
  project_id: z.string({ required_error: 'project_id is required' }).min(1, 'project_id is required'),
  limit_nodes: z.coerce.number().int().positive().default(50),
  min_weight: z.coerce.number().int().positive().default(1),
  ...commonFiltersSchema
}).refine(yearRangeRefinement, yearRangeMessage);

// Schema cho /analytics/rankings
export const getRankingsSchema = z.object({
  project_id: z.string({ required_error: 'project_id is required' }).min(1, 'project_id is required'),
  limit: z.coerce.number().int().positive().default(5),
  ...commonFiltersSchema
}).refine(yearRangeRefinement, yearRangeMessage);

// Schema cho /analytics/matrix/productivity
export const getProductivityMatrixSchema = z.object({
  project_id: z.string({ required_error: 'project_id is required' }).min(1, 'project_id is required'),
  limit: z.coerce.number().int().positive().max(200).default(50),
  ...commonFiltersSchema
}).refine(yearRangeRefinement, yearRangeMessage);

// Schema cho /analytics/network/chord
export const getCountryCollaborationChordSchema = z.object({
  project_id: z.string({ required_error: 'project_id is required' }).min(1, 'project_id is required'),
  limit_countries: z.coerce.number().int().positive().max(30).default(10),
  min_value: z.coerce.number().int().positive().default(1),
  ...commonFiltersSchema
}).refine(yearRangeRefinement, yearRangeMessage);

// Schema cho /analytics/journals/migration
export const getJournalMigrationSchema = z.object({
  project_id: z.string({ required_error: 'project_id is required' }).min(1, 'project_id is required'),
  include_legacy: z.preprocess((val) => {
    if (val === undefined) return true;
    if (typeof val === 'string') return val === 'true';
    return Boolean(val);
  }, z.boolean()),
  ...commonFiltersSchema
}).refine(yearRangeRefinement, yearRangeMessage);

// Schema cho /analytics/network/topology
export const getNetworkTopologySchema = z.object({
  project_id: z.string({ required_error: 'project_id is required' }).min(1, 'project_id is required'),
  network_type: z.enum(['conceptual', 'collaboration', 'all']).default('all'),
  limit_nodes: z.coerce.number().int().positive().max(150).default(50),
  min_weight: z.coerce.number().min(0).default(0.1),
  ...commonFiltersSchema
}).refine(yearRangeRefinement, yearRangeMessage);

// Schema cho /analytics/development-trends
export const getDevelopmentTrendsSchema = z.object({
  timeframe: z.string().optional().default('Last 5 Years'),
  domain: z.string().optional(),
  region: z.string().optional()
});