import express from 'express';

import {
  validateQuery
} from '../middlewares/analytics.validator.js';
import {
  getTrendsSchema,
  getFrontierSchema,
  getDistributionSchema,
  getForecastSchema,
  getTopEntitiesSchema,
  getGeoDistributionSchema, getCountryCollaborationChordSchema,
  getJournalQuartileSchema,
  getJournalRankingSchema,
  getCollaborationNetworkSchema, getRankingsSchema, getProductivityMatrixSchema, getJournalMigrationSchema,
  getNetworkTopologySchema,
  getDevelopmentTrendsSchema
} from '../middlewares/analytics.validator.js';
import {
  fetchTrends,
  fetchFrontier,
  fetchDistribution,
  fetchForecast,
  getTopEntitiesHandler,
  fetchGeoDistribution,
  fetchImpactQuartiles,
  fetchJournalQuartileDistribution,
  fetchJournalRanking, 
  fetchCountryCollaborationChord,
  fetchTopicIntensityMatrix,
  fetchRankings,
  fetchProductivityMatrix,
  fetchJournalMigration,
  fetchNetworkTopology,
  fetchKeywordVectors,
  fetchCollaborationNetwork,
  fetchDevelopmentTrends
} from '../controller/analytics.controller.js';

const router = express.Router();

/**
 * Get publication & citation historical trends for chart rendering.
 *
 * @openapi
 * /analytics/trends:
 *   get:
 *     summary: Get publication & citation historical trends
 *     tags:
 *       - Analytics
 *     parameters:
 *       - in: query
 *         name: project_id
 *         schema: { type: string }
 *         description: 'ID của project để xác định phạm vi phân tích. Nếu không có, sẽ lấy dữ liệu toàn cục.'
 *       - in: query
 *         name: subject_area
 *         schema:
 *           type: string
 *         description: 'Lọc hẹp thêm theo subject area cụ thể.'
 *       - in: query
 *         name: keywords
 *         schema:
 *           type: string
 *         description: 'Lọc hẹp thêm theo danh sách keyword ngăn cách bởi dấu phẩy.'
 *       - in: query
 *         name: from_year
 *         schema:
 *           type: integer
 *         description: 'Năm bắt đầu lọc dữ liệu.'
 *       - in: query
 *         name: to_year
 *         schema:
 *           type: integer
 *         description: 'Năm kết thúc lọc dữ liệu.'
 *     responses:
 *       200:
 *         description: Trend data returned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: Fetch publication trends successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     timeline:
 *                       type: array
 *                       items:
 *                         type: string
 *                       example: ["2021", "2022", "2023", "2024", "2025", "2026"]
 *                     series:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           name:
 *                             type: string
 *                             example: Articles
 *                           data:
 *                             type: array
 *                             items:
 *                               type: integer
 *                             example: [120, 150, 185, 220, 280, 329]
 */
router.get('/trends', validateQuery(getTrendsSchema), fetchTrends);

/**
 * Get emerging and frontier tech topics based on Impact vs Velocity.
 *
 * @openapi
 * /analytics/frontier:
 *   get:
 *     summary: Get frontier technology topics
 *     description: Returns emerging and frontier technology topics categorized by Impact vs Citation Velocity, suitable for bubble chart visualization.
 *     tags:
 *       - Analytics
 *     parameters:
 *       - in: query
 *         name: subjectArea
 *         schema:
 *           type: string
 *         description: 'Tên lĩnh vực chính của dự án để lọc dữ liệu (ví dụ: Computer Science).'
 *       - in: query
 *         name: keywords
 *         schema:
 *           type: string
 *         description: 'Danh sách tên hoặc ID Keyword ngăn cách bởi dấu phẩy để lọc dữ liệu (ví dụ: AI Agent,Machine Learning).'
 *       - in: query
 *         name: keywordIds
 *         schema:
 *           type: string
 *         description: '(Tùy chọn khác) Danh sách ID hoặc tên Keyword ngăn cách bởi dấu phẩy để lọc dữ liệu.'
 *     responses:
 *       200:
 *         description: Frontier topics returned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: Fetch frontier topics successfully
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       topic:
 *                         type: string
 *                         example: Gen AI
 *                       impactFactor:
 *                         type: number
 *                         format: float
 *                         example: 2.4
 *                       citationVelocity:
 *                         type: number
 *                         format: float
 *                         example: 4.5
 *                       status:
 *                         type: string
 *                         enum: [EMERGING, FRONTIER]
 *                         example: EMERGING
 *       500:
 *         description: Internal Server Error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Internal Server Error
 */router.get('/frontier', validateQuery(getFrontierSchema), fetchFrontier);

/**
 * Get research landscape and impact quartile distribution.
 *
 * @openapi
 * /analytics/distribution:
 *   get:
 *     summary: Get research landscape sector or impact quartile distribution
 *     description: Returns percentage distribution for charts based on project tracking scope.
 *     tags:
 *       - Analytics
 *     parameters:
 *       - in: query
 *         name: project_id
 *         required: false
 *         schema:
 *           type: string
 *         description: 'ID của project cần lấy dữ liệu distribution.'
 *       - in: query
 *         name: distribution_type
 *         schema:
 *           type: string
 *           enum: [sector, impact_quartile]
 *         description: 'Loại phân bổ cần lấy. Mặc định là sector.'
 *       - in: query
 *         name: subject_area
 *         schema:
 *           type: string
 *         description: 'Lọc hẹp thêm theo subject area cụ thể.'
 *       - in: query
 *         name: keywords
 *         schema:
 *           type: string
 *         description: 'Lọc hẹp thêm theo danh sách keyword ngăn cách bởi dấu phẩy.'
 *       - in: query
 *         name: from_year
 *         schema:
 *           type: integer
 *         description: 'Năm bắt đầu lọc dữ liệu.'
 *       - in: query
 *         name: to_year
 *         schema:
 *           type: integer
 *         description: 'Năm kết thúc lọc dữ liệu.'
 *     responses:
 *       200:
 *         description: Distribution data returned successfully
 *         content:
 *           application/json:
 *             schema: 
 *               type: object
 *               properties:
 *                 code:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: Fetch distribution successfully
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                         example: Biotech
 *                       percentage:
 *                         type: number
 *                         example: 42
 *       400:
 *         description: Bad Request (missing project_id, invalid type or year range)
 *       404:
 *         description: Project not found
 */
router.get('/distribution', validateQuery(getDistributionSchema), fetchDistribution);

/**
 * @openapi
 * /analytics/forecast:
 *   get:
 *     summary: Get forecast insights for a project
 *     description: |
 *       Returns three blocks of insights (PEAK, ALERT, SYNERGY) for a given project,
 *       based on an analysis of its associated subject categories against global data.
 *     tags:
 *       - Analytics
 *     parameters:
 *       - in: query
 *         name: project_id
 *         schema:
 *           type: string
 *         required: true
 *         description: The ID of the project for which to generate forecast insights.
 *     responses:
 *       200:
 *         description: Forecast insights returned successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: Fetch forecast insights successfully
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       type:
 *                         type: string
 *                         enum: [PEAK, ALERT, SYNERGY]
 *                         example: PEAK
 *                       title:
 *                         type: string
 *                         example: Predictive Peak
 *                       content:
 *                         type: string
 *                         example: "Bio-engineering is projected to reach its citation apex in Q3 2027..."
 *       400:
 *         description: Bad Request - project_id is missing.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: integer
 *                   example: 400
 *                 message:
 *                   type: string
 *                   example: project_id is required
 *                 data:
 *                   type: object
 *                   nullable: true
 *                   example: null
 *       404:
 *         description: Not Found - Project or its subject categories could not be found.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: integer
 *                   example: 404
 *                 message:
 *                   type: string
 *                   example: "Project not found"
 *                 data:
 *                   type: object
 *                   nullable: true
 *                   example: null
 */
router.get('/forecast', validateQuery(getForecastSchema), fetchForecast);

/**
 * @openapi
 * /analytics/top-entities:
 *   get:
 *     summary: Lấy danh sách các tổ chức/viện nghiên cứu hàng đầu
 *     description: >
 *       Trả về danh sách các tổ chức được xếp hạng dựa trên một điểm số tổng hợp (số lượng bài báo, trích dẫn, H-index...).
 *       API yêu cầu `project_id` để xác định phạm vi phân tích (lĩnh vực, từ khóa) mà project đang theo dõi.
 *     tags:
 *       - Analytics
 *     parameters:
 *       - in: query
 *         name: project_id
 *         schema:
 *           type: string
 *         required: true
 *         description: 'ID của project để xác định phạm vi phân tích.'
 *       - in: query
 *         name: entity_type
 *         schema:
 *           type: string
 *           enum: [institution, university, research_center]
 *         description: 'Loại tổ chức cần xếp hạng. Mặc định là "institution".'
 *       - in: query
 *         name: from_year
 *         schema:
 *           type: integer
 *         description: 'Năm bắt đầu lọc dữ liệu.'
 *       - in: query
 *         name: to_year
 *         schema:
 *           type: integer
 *         description: 'Năm kết thúc lọc dữ liệu.'
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: 'Số lượng kết quả trả về. Mặc định là 10.'
 *     responses:
 *       200:
 *         description: Lấy dữ liệu thành công.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: Fetch top entities successfully
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                         example: "Stanford University"
 *                       score:
 *                         type: number
 *                         example: 94.2
 */router.get('/top-entities', validateQuery(getTopEntitiesSchema), getTopEntitiesHandler);

/**
 * @openapi
 * /analytics/geo-distribution:
 *   get:
 *     summary: Get geographical research distribution by project
 *     description: Returns research output density by country matching the project tracking scope and optional filters.
 *     tags:
 *       - Analytics
 *     parameters:
 *       - in: query
 *         name: project_id
 *         schema:
 *           type: string
 *         required: true
 *         description: The ID of the project.
 *       - in: query
 *         name: subject_area
 *         schema:
 *           type: string
 *         description: Narrow down research output to a specific subject area.
 *       - in: query
 *         name: keywords
 *         schema:
 *           type: string
 *         description: Comma-separated list of keywords to filter by.
 *       - in: query
 *         name: from_year
 *         schema:
 *           type: integer
 *         description: Filter starting from this publication year.
 *       - in: query
 *         name: to_year
 *         schema:
 *           type: integer
 *         description: Filter up to this publication year.
 *     responses:
 *       200:
 *         description: Geographical metrics returned successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: Fetch geographical metrics successfully
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       countryCode:
 *                         type: string
 *                         example: US
 *                       intensity:
 *                         type: string
 *                         enum: [PEAK, HIGH, MEDIUM, LOW]
 *                         example: PEAK
 *                       count:
 *                         type: integer
 *                         example: 85400
 *       400:
 *         description: Bad Request (missing project_id or invalid year range)
 *       404:
 *         description: Project not found
 */
router.get('/geo-distribution', validateQuery(getGeoDistributionSchema), fetchGeoDistribution);

/**
 * @openapi
 * /analytics/journals/quartiles:
 *   get:
 *     summary: Get journal quartile distribution for a project
 *     description: Returns the Scimago quartile distribution of journals related to articles within a project's scope.
 *     tags:
 *       - Analytics
 *     parameters:
 *       - in: query
 *         name: project_id
 *         schema:
 *           type: string
 *         required: true
 *         description: The ID of the project to get the quartile distribution for.
 *       - in: query
 *         name: subject_area
 *         schema:
 *           type: string
 *         description: Further filter the articles by a specific subject area name.
 *       - in: query
 *         name: keywords
 *         schema:
 *           type: string
 *         description: Comma-separated list of keywords to filter articles by (e.g., "AI,Machine Learning").
 *       - in: query
 *         name: from_year
 *         schema:
 *           type: integer
 *         description: The starting publication year for filtering articles.
 *       - in: query
 *         name: to_year
 *         schema:
 *           type: integer
 *         description: The ending publication year for filtering articles.
 *     responses:
 *       200:
 *         description: Quartile distribution data returned successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: Fetch quartile distribution successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     totalJournals:
 *                       type: integer
 *                       example: 2400
 *                     distribution:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           group:
 *                             type: string
 *                             example: "Q1 (High Impact)"
 *                           percentage:
 *                             type: number
 *                             example: 42
 */router.get('/journals/quartiles', validateQuery(getJournalQuartileSchema), fetchJournalQuartileDistribution);

/**
 * @openapi
 * /analytics/journals/ranking:
 *   get:
 *     summary: Get journal rankings for a project
 *     description: Returns journal rankings related to articles within a project's scope, sorted by impact factor and article count.
 *     tags:
 *       - Analytics
 *     parameters:
 *       - in: query
 *         name: project_id
 *         schema:
 *           type: string
 *         required: true
 *         description: The ID of the project to get the journal rankings for.
 *       - in: query
 *         name: subject_area
 *         schema:
 *           type: string
 *         description: Further filter the articles by a specific subject area name.
 *       - in: query
 *         name: keywords
 *         schema:
 *           type: string
 *         description: Comma-separated list of keywords to filter articles by (e.g., "AI,Machine Learning").
 *       - in: query
 *         name: from_year
 *         schema:
 *           type: integer
 *         description: The starting publication year for filtering articles.
 *       - in: query
 *         name: to_year
 *         schema:
 *           type: integer
 *         description: The ending publication year for filtering articles.
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Maximum number of journals to return.
 *     responses:
 *       200:
 *         description: Fetch journal rankings successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: Fetch journal rankings successfully
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       impactFactor:
 *                         type: number
 */
router.get('/journals/ranking', validateQuery(getJournalRankingSchema), fetchJournalRanking);

/**
 * @openapi
 * /analytics/network/collaboration:
 *   get:
 *     summary: Get global collaboration network
 *     description: Returns a network graph (nodes and edges) of authors and institutions collaborating in the given project scope.
 *     tags:
 *       - Analytics
 *     parameters:
 *       - in: query
 *         name: project_id
 *         schema:
 *           type: string
 *         required: true
 *         description: The ID of the project.
 *       - in: query
 *         name: subject_area
 *         schema:
 *           type: string
 *         description: Narrow down research output to a specific subject area.
 *       - in: query
 *         name: keywords
 *         schema:
 *           type: string
 *         description: Comma-separated list of keywords to filter by.
 *       - in: query
 *         name: from_year
 *         schema:
 *           type: integer
 *         description: Filter starting from this publication year.
 *       - in: query
 *         name: to_year
 *         schema:
 *           type: integer
 *         description: Filter up to this publication year.
 *       - in: query
 *         name: limit_nodes
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of nodes to return.
 *       - in: query
 *         name: min_weight
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Minimum weight of edges to include.
 *     responses:
 *       200:
 *         description: Collaboration network returned successfully.
 *       400:
 *         description: Bad Request (missing project_id)
 *       404:
 *         description: Project not found
 */
router.get('/network/collaboration', validateQuery(getCollaborationNetworkSchema), fetchCollaborationNetwork);

/**
 * @openapi
 * /analytics/rankings:
 *   get:
 *     summary: Fetch influential rankings (authors and institutions)
 *     description: Returns rankings of the top authors and leading research institutions matching the project's tracking scope and optional client filters.
 *     tags:
 *       - Analytics
 *     parameters:
 *       - in: query
 *         name: project_id
 *         schema:
 *           type: string
 *         required: true
 *         description: The ID of the project.
 *       - in: query
 *         name: subject_area
 *         schema:
 *           type: string
 *         description: Optional subject area filter.
 *       - in: query
 *         name: keywords
 *         schema:
 *           type: string
 *         description: Comma-separated list of keywords to filter by.
 *       - in: query
 *         name: from_year
 *         schema:
 *           type: integer
 *         description: Filter starting from this publication year.
 *       - in: query
 *         name: to_year
 *         schema:
 *           type: integer
 *         description: Filter up to this publication year.
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 5
 *         description: Maximum number of entities in each list.
 *     responses:
 *       200:
 *         description: Influential rankings returned successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: Fetch influential rankings successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     authors:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           rank:
 *                             type: integer
 *                             example: 1
 *                           name:
 *                             type: string
 *                             example: Dr. Helena Vance
 *                           score:
 *                             type: number
 *                             example: 94.2
 *                           metric:
 *                             type: string
 *                             example: Impact Score
 *                     institutions:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           rank:
 *                             type: integer
 *                             example: 1
 *                           name:
 *                             type: string
 *                             example: Stanford Bio-Dynamics Lab
 *                           score:
 *                             type: number
 *                             example: 98.1
 *                           metric:
 *                             type: string
 *                             example: Citations
 *       400:
 *         description: Bad Request (missing project_id, invalid limit or year range)
 *       404:
 *         description: Project not found
 */
router.get('/rankings', validateQuery(getRankingsSchema), fetchRankings);

/**
 * @openapi
 * /analytics/matrix/productivity:
 *   get:
 *     summary: Get author productivity vs impact matrix data
 *     description: Returns data coordinates (yearlyOutput, hIndex) for each author within the project tracking scope and optional client filters.
 *     tags:
 *       - Analytics
 *     parameters:
 *       - in: query
 *         name: project_id
 *         schema:
 *           type: string
 *         required: true
 *         description: The ID of the project.
 *       - in: query
 *         name: subject_area
 *         schema:
 *           type: string
 *         description: Optional subject area filter.
 *       - in: query
 *         name: keywords
 *         schema:
 *           type: string
 *         description: Comma-separated list of keywords to filter by.
 *       - in: query
 *         name: from_year
 *         schema:
 *           type: integer
 *         description: Filter starting from this publication year.
 *       - in: query
 *         name: to_year
 *         schema:
 *           type: integer
 *         description: Filter up to this publication year.
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of author points to return.
 *     responses:
 *       200:
 *         description: Productivity matrix points returned successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: Fetch matrix points successfully
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       authorId:
 *                         type: string
 *                         example: "12345"
 *                       yearlyOutput:
 *                         type: number
 *                         example: 12
 *                       hIndex:
 *                         type: number
 *                         example: 35
 *       400:
 *         description: Bad Request (missing project_id, invalid limit or year range)
 *       404:
 *         description: Project not found
 */
router.get('/matrix/productivity', validateQuery(getProductivityMatrixSchema), fetchProductivityMatrix);

/**
 * @openapi
 * /analytics/network/chord:
 *   get:
 *     summary: Get country collaboration chord data
 *     description: Returns data for rendering a chord diagram of research collaboration between countries, based on co-authored articles within a project's scope.
 *     tags:
 *       - Analytics
 *     parameters:
 *       - in: query
 *         name: project_id
 *         schema: { type: string }
 *         required: true
 *         description: The ID of the project to get the country collaboration chord for.
 *       - in: query
 *         name: subject_area
 *         schema: { type: string }
 *         description: Further filter by a specific subject area name.
 *       - in: query
 *         name: keywords
 *         schema: { type: string }
 *         description: Comma-separated list of keywords to filter by (e.g., "AI,Machine Learning").
 *       - in: query
 *         name: from_year
 *         schema: { type: integer }
 *         description: The starting publication year for filtering articles.
 *       - in: query
 *         name: to_year
 *         schema: { type: integer }
 *         description: The ending publication year for filtering articles.
 *       - in: query
 *         name: limit_countries
 *         schema: { type: integer, default: 10, maximum: 30 }
 *         description: Maximum number of top collaborating countries to include.
 *       - in: query
 *         name: min_value
 *         schema: { type: integer, default: 1 }
 *         description: Minimum co-authorship value for a pair to be included.
 *     responses:
 *       200:
 *         description: Collaboration chord data returned successfully.
 *       400:
 *         description: Bad Request (e.g., missing project_id, invalid year range or limits).
 *       404:
 *         description: Project not found.
 */
router.get('/network/chord', validateQuery(getCountryCollaborationChordSchema), fetchCountryCollaborationChord);

/**
 * @openapi
 * /analytics/journals/migration:
 *   get:
 *     summary: Get journal migration analysis
 *     description: Returns flow of journal access model migration between two given years.
 *     tags:
 *       - Analytics
 *     parameters:
 *       - in: query
 *         name: project_id
 *         schema:
 *           type: string
 *         required: true
 *       - in: query
 *         name: include_legacy
 *         schema:
 *           type: boolean
 *       - in: query
 *         name: from_y/**
 * @openapi
 * /analytics/network/topology:
 *   get:
 *     summary: Get network graph topology (nodes and edges)
 *     tags:
 *       - Analytics
 *     parameters:
 *       - in: query
 *         name: project_id
 *         schema: { type: string }
 *         required: true
 *       - in: query
 *         name: network_type
 *         schema: { type: string, enum: ['conceptual', 'collaboration', 'all'] }
 *       - in: query
 *         name: subject_area
 *         schema: { type: string }
 *       - in: query
 *         name: keywords
 *         schema: { type: string }
 *       - in: query
 *         name: from_year
 *         schema: { type: integer }
 *       - in: query
 *         name: to_year
 *         schema: { type: integer }
 *       - in: query
 *         name: limit_nodes
 *         schema: { type: integer }
 *       - in: query
 *         name: min_weight
 *         schema: { type: number }
 *     responses:
 *       200:
 *         description: Success
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: integer, example: 200 }
 *                 message: { type: string, example: 'Fetch network topology successfully' }
 *                 data:
 *                   type: object
 *                   properties:
 *                     nodes: { type: array, items: { type: object } }
 *                     edges: { type: array, items: { type: object } }
 */
router.get('/network/topology', validateQuery(getNetworkTopologySchema), fetchNetworkTopology);

/**
 * @openapi
 * /analytics/keywords/vectors:
 *   get:
 *     summary: Get keyword trend growth and volume vectors
 *     description: Returns a list of keywords with their total volume (articles count) in the current period and growth rate compared to the previous period.
 *     tags:
 *       - Analytics
 *     parameters:
 *       - in: query
 *         name: project_id
 *         schema:
 *           type: string
 *         required: true
 *         description: The ID of the project.
 *       - in: query
 *         name: subject_area
 *         schema:
 *           type: string
 *         description: Optional subject area filter.
 *       - in: query
 *         name: keywords
 *         schema:
 *           type: string
 *         description: Comma-separated list of keywords to filter by.
 *       - in: query
 *         name: from_year
 *         schema:
 *           type: integer
 *         description: Filter starting from this publication year.
 *       - in: query
 *         name: to_year
 *         schema:
 *           type: integer
 *         description: Filter up to this publication year.
 *       - in: query
 *         name: window_months
 *         schema:
 *           type: integer
 *           default: 12
 *         description: Analytical time window in months (1-36).
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Maximum number of keyword vectors to return.
 *     responses:
 *       200:
 *         description: Keyword vectors returned successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: Fetch trend vectors successfully
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       keyword:
 *                         type: string
 *                         example: "LLM Bias"
 *                       volume:
 *                         type: integer
 *                         example: 4200
 *                       growth:
 *                         type: number
 *                         example: 12.4
 *       400:
 *         description: Bad Request (missing project_id, invalid limit, window_months or year range)
 *       404:
 *         description: Project not found
 */
router.get('/keywords/vectors', fetchKeywordVectors);

/**
 * @openapi
 * /analytics/matrix/intensity:
 *   get:
 *     summary: Get Topic Intensity Matrix
 *     description: Returns a heatmap matrix representing the research intensity of authors or institutions across different topics.
 *     tags:
 *       - Analytics
 *     parameters:
 *       - in: query
 *         name: project_id
 *         schema:
 *           type: string
 *         required: true
 *         description: The ID of the project.
 *       - in: query
 *         name: row_type
 *         schema:
 *           type: string
 *           enum: [author, institution]
 *           default: author
 *         description: The entity type for matrix rows.
 *       - in: query
 *         name: subject_area
 *         schema:
 *           type: string
 *         description: Narrow down research output to a specific subject area.
 *       - in: query
 *         name: keywords
 *         schema:
 *           type: string
 *         description: Comma-separated list of keywords to filter by.
 *       - in: query
 *         name: from_year
 *         schema:
 *           type: integer
 *         description: Filter starting from this publication year.
 *       - in: query
 *         name: to_year
 *         schema:
 *           type: integer
 *         description: Filter up to this publication year.
 *       - in: query
 *         name: limit_rows
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Maximum number of rows (authors/institutions). Max 50.
 *       - in: query
 *         name: limit_topics
 *         schema:
 *           type: integer
 *           default: 8
 *         description: Maximum number of topics (columns). Max 30.
 *     responses:
 *       200:
 *         description: Topic Intensity Matrix returned successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: integer
 *                 message:
 *                   type: string
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       rowName:
 *                         type: string
 *                       topic:
 *                         type: string
 *                       intensity:
 *                         type: number
 *       400:
 *         description: Bad Request
 *       404:
 *         description: Project not found
 */
router.get('/matrix/intensity', fetchTopicIntensityMatrix);
router.get('/development-trends', validateQuery(getDevelopmentTrendsSchema), fetchDevelopmentTrends);

export default router;
