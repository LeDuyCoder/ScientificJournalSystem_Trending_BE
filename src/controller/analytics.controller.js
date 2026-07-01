/**
 * Express controller for analytics endpoints.
 */
import logger from '../../utils/logger.js';
import { z } from 'zod';
import { getTopEntities } from "../services/analytics.service.js";
import { getPublicationTrends } from "../services/trends.service.js";
import { getFrontierTopics } from "../services/frontier.service.js";
import { getDistribution } from "../services/distribution.service.js";
import { getForecastInsights } from "../services/forecast.service.js";
import { getGeoDistribution } from "../services/geoDistribution.service.js";
import { getImpactQuartiles } from '../services/impactQuartiles.service.js';
import { getCollaborationNetwork } from '../services/network.service.js';
import { getJournalQuartileDistribution } from "../services/journal-quartile.service.js";
import { getJournalRanking } from "../services/journal-ranking.service.js";
import { getTopicIntensityMatrix } from '../services/matrix.service.js';
import { getInfluentialRankings } from "../services/rankings.service.js";
import { getProductivityMatrix } from "../services/productivityMatrix.service.js";
import { getCountryCollaborationChord } from "../services/countryCollaboration.service.js";
import { getJournalMigrationAnalysis } from '../services/migration.service.js';
import { getNetworkTopology } from '../services/topology.service.js';
import { getKeywordVectors } from '../services/keywordVectors.service.js';
import { getDashboardSearchSuggestions } from '../services/dashboardSearch.service.js';
import { getDevelopmentTrends, getProjectCategories } from '../services/developmentTrends.service.js';


const getTopEntitiesSchema = z.object({
  project_id: z.string().min(1, 'project_id is required'),
  entity_type: z
    .enum(['institution', 'university', 'research_center'])
    .optional(),
  from_year: z.coerce.number().int().optional(),
  to_year: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().positive().max(50).optional().default(10),
});

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
    // Dữ liệu đã được validate và chuẩn hóa bởi middleware
    const data = await getPublicationTrends(req.validatedQuery);

    res.json({
      code: 200,
      message: "Fetch publication trends successfully",
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

    res.status(200).json({
      code: 200,
      message: "Fetch quartile distribution successfully",
      data,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ code: err.status, message: err.message, data: null });
    }
    next(err);
  }
}

/**
 * Handler for GET /analytics/journals/ranking
 * Fetches and returns journal rankings within a project's scope.
 *
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express next middleware function.
 */
export async function fetchJournalRanking(req, res, next) {
  try {
    const { project_id, subject_area, keywords, from_year, to_year, limit } = req.validatedQuery;

    const data = await getJournalRanking({
      projectId: String(project_id),
      subjectArea: subject_area ? String(subject_area) : undefined,
      keywords: keywords ? String(keywords) : undefined,
      fromYear: from_year,
      toYear: to_year,
      limit: limit,
    });

    res.status(200).json({
      code: 200,
      message: "Fetch journal rankings successfully",
      data,
    });
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
    const query = req.validatedQuery;

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
      message: "Fetch top entities successfully",
      data,
    });
  } catch (error) {
    logger.error("Error in getTopEntitiesHandler:", error);
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
      message: "Fetch frontier topics successfully",
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

    const options = {
      project_id,
      distribution_type,
      subject_area,
      keywords,
      from_year,
      to_year,
    };

    const data = await getDistribution(options);

    res.json({
      code: 200,
      message: "Fetch distribution successfully",
      data,
    });
  } catch (error) {
    if (error.status === 404 || error.code === 404) {
      return res.status(404).json({
        code: 404,
        message: error.message,
        data: null,
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
    const { project_id: projectId } = req.validatedQuery;

    // Service sẽ xử lý lỗi 404 nếu không tìm thấy project
    const data = await getForecastInsights(projectId);

    return res.json({
      code: 200,
      message: "Fetch forecast insights successfully",
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
    const { project_id: projectId, subject_area, keywords, from_year, to_year } = req.validatedQuery;

    const filters = {
      subjectArea: subject_area,
      keywords: keywords,
      fromYear: from_year,
      toYear: to_year,
    };

    const data = await getGeoDistribution(projectId, filters);

    return res.json({
      code: 200,
      message: "Fetch geographical metrics successfully",
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
 * Return impact quartile summary metric for a project.
 *
 * Route: GET /analytics/impact-quartiles
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function fetchImpactQuartiles(req, res, next) {
  try {
    const { project_id: projectId, subject_area, keywords, from_year, to_year } = req.validatedQuery;

    const filters = {
      subjectArea: subject_area,
      keywords: keywords,
      fromYear: from_year,
      toYear: to_year,
    };

    const data = await getImpactQuartiles(projectId, filters);

    return res.json({
      code: 200,
      message: "Fetch impact quartile summary successfully",
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
/**
 * Fetch Topic Intensity Matrix
 *
 * Route: GET /analytics/matrix/intensity
 */
export async function fetchTopicIntensityMatrix(req, res, next) {
  try {
    const payload = { ...req.query, ...req.body };
    const data = await getTopicIntensityMatrix(payload);

    res.json({
      code: 200,
      message: 'Fetch topic intensity matrix successfully',
      data,
    });
  } catch (err) {
    const statusCode = err.status || err.code;
    if (statusCode && Number.isInteger(statusCode) && statusCode !== 500) {
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
 * Fetch Global Collaboration Network
 *
 * Route: GET /analytics/network/collaboration
 */
export async function fetchCollaborationNetwork(req, res, next) {
  try {
    const data = await getCollaborationNetwork(req.validatedQuery);

    res.json({
      code: 200,
      message: "Fetch global collaboration network successfully",
      data,
    });
  } catch (err) {
    const statusCode = err.status || err.code;
    if (statusCode && Number.isInteger(statusCode) && statusCode !== 500) {
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
 * Return influential rankings (authors and institutions) for a project.
 *
 * Route: GET /analytics/rankings
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function fetchRankings(req, res, next) {
  try {
    const {
      project_id: projectId,
      subject_area,
      keywords,
      from_year,
      to_year,
      limit
    } = req.validatedQuery;

    const filters = {
      subjectArea: subject_area,
      keywords: keywords,
      fromYear: from_year,
      toYear: to_year,
      limit,
    };

    const data = await getInfluentialRankings(projectId, filters);

    return res.json({
      code: 200,
      message: "Fetch influential rankings successfully",
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
 * Return coordinates for the Author Productivity vs Impact Matrix chart.
 *
 * Route: GET /analytics/matrix/productivity
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function fetchProductivityMatrix(req, res, next) {
  try {
    const {
      project_id: projectId,
      subject_area,
      keywords,
      from_year,
      to_year,
      limit
    } = req.validatedQuery;

    const filters = {
      subjectArea: subject_area,
      keywords: keywords,
      fromYear: from_year,
      toYear: to_year,
      limit,
    };

    const data = await getProductivityMatrix(projectId, filters);

    return res.json({
      code: 200,
      message: "Fetch matrix points successfully",
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
 * Handle GET /analytics/journals/migration
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export async function fetchJournalMigration(req, res, next) {
  try {
    const result = await getJournalMigrationAnalysis(req.validatedQuery);
    return res.status(200).json({
      code: 200,
      message: "Fetch migration analysis successfully",
      data: result
    });
  } catch (err) {
    if (err.status === 404 || err.code === 404) {
      return res.status(404).json({
        code: 404,
        message: 'Project not found',
        data: null
      });
    }
    next(err);
  }
}

/**
 * Handler để lấy dữ liệu Country Collaboration Chord.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export async function fetchCountryCollaborationChord(req, res, next) {
  try {
    const data = await getCountryCollaborationChord(req.validatedQuery);
    res.status(200).json({
      code: 200,
      message: "Fetch collaboration chord successfully",
      data: data,
    });
  } catch (error) {
    if (error.status === 404) {
      return res.status(404).json({ code: 404, message: error.message, data: null });
    }
    next(error);
  }
}

/**
/**
 * Handler for GET /analytics/network/topology
 * Fetches and returns network graph topology (nodes and edges) for conceptual or collaboration networks.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export async function fetchNetworkTopology(req, res, next) {
  try {
    const data = await getNetworkTopology(req.validatedQuery);

    res.status(200).json({
      code: 200,
      message: 'Fetch network topology successfully',
      data,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ code: err.status, message: err.message, data: null });
    }
    next(err);
  }
}

/**
 * Return keyword growth and volume trend vectors for a project.
 *
 * Route: GET /analytics/keywords/vectors
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function fetchKeywordVectors(req, res, next) {
  try {
    const projectId = req.query.project_id;

    if (!projectId) {
      return res.status(400).json({
        code: 400,
        message: 'project_id is required',
        data: null,
      });
    }

    const fromYear = req.query.from_year ? Number(req.query.from_year) : undefined;
    const toYear = req.query.to_year ? Number(req.query.to_year) : undefined;

    if (fromYear !== undefined && Number.isNaN(fromYear)) {
      return res.status(400).json({
        code: 400,
        message: 'Invalid from_year parameter',
        data: null,
      });
    }
    if (toYear !== undefined && Number.isNaN(toYear)) {
      return res.status(400).json({
        code: 400,
        message: 'Invalid to_year parameter',
        data: null,
      });
    }

    if (fromYear !== undefined && toYear !== undefined && fromYear > toYear) {
      return res.status(400).json({
        code: 400,
        message: 'Invalid year range',
        data: null,
      });
    }

    let windowMonths = 12;
    if (req.query.window_months !== undefined) {
      const parsedWindow = Number(req.query.window_months);
      if (Number.isNaN(parsedWindow) || parsedWindow <= 0 || parsedWindow > 36) {
        return res.status(400).json({
          code: 400,
          message: 'Invalid window_months',
          data: null,
        });
      }
      windowMonths = parsedWindow;
    }

    let limit = 10;
    if (req.query.limit !== undefined) {
      const parsedLimit = Number(req.query.limit);
      if (Number.isNaN(parsedLimit) || parsedLimit <= 0) {
        return res.status(400).json({
          code: 400,
          message: 'Invalid limit',
          data: null,
        });
      }
      limit = parsedLimit > 50 ? 50 : parsedLimit;
    }

    const filters = {
      subjectArea: req.query.subject_area ? String(req.query.subject_area).trim() : undefined,
      keywords: req.query.keywords || req.query.keyword,
      fromYear,
      toYear,
      windowMonths,
      limit,
    };

    const data = await getKeywordVectors(projectId, filters);

    return res.json({
      code: 200,
      message: 'Fetch trend vectors successfully',
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
 * Return search suggestions for dashboard search input.
 *
 * Route: GET /dashboard/search
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function fetchDashboardSearch(req, res, next) {
  try {
    const q = req.query.q !== undefined ? String(req.query.q) : '';
    const qClean = q.trim();

    // 1. If q is missing or too short, return 200 with empty suggestions array
    if (!q || qClean.length < 2) {
      return res.json({
        code: 200,
        message: 'Search suggestions fetched successfully',
        data: {
          suggestions: [],
        },
      });
    }

    const type = req.query.type ? String(req.query.type).toLowerCase().trim() : 'all';
    const allowedTypes = ['all', 'article', 'journal', 'author', 'institution', 'keyword', 'topic'];

    if (!allowedTypes.includes(type)) {
      return res.status(400).json({
        code: 400,
        message: 'Invalid search type',
        data: null,
      });
    }

    let limit = 8;
    if (req.query.limit !== undefined) {
      const parsedLimit = Number(req.query.limit);
      if (Number.isNaN(parsedLimit) || parsedLimit <= 0) {
        return res.status(400).json({
          code: 400,
          message: 'Invalid limit',
          data: null,
        });
      }
      limit = parsedLimit > 20 ? 20 : parsedLimit;
    }

    const projectId = req.query.project_id ? req.query.project_id : null;

    const suggestions = await getDashboardSearchSuggestions(qClean, type, projectId, limit);

    return res.json({
      code: 200,
      message: 'Search suggestions fetched successfully',
      data: {
        suggestions,
      },
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

export async function fetchDevelopmentTrends(req, res, next) {
  try {
    const data = await getDevelopmentTrends(req.validatedQuery);
    res.json({
      code: 200,
      message: 'Fetch development trends successfully',
      data
    });
  } catch (err) {
    console.error('Error in fetchDevelopmentTrends:', err);
    next(err);
  }
}

export async function fetchProjectSubjectCategories(req, res, next) {
  try {
    const { project_id } = req.validatedQuery;
    const { subjectArea, categories } = await getProjectCategories(project_id);

    const page = parseInt(req.validatedQuery.page, 10) || 1;
    const limit = Math.min(parseInt(req.validatedQuery.limit, 10) || 10, 100);
    const search = req.validatedQuery.search ? String(req.validatedQuery.search).trim().toLowerCase() : '';

    let filtered = categories;
    if (search) {
      filtered = categories.filter(c => c.name.toLowerCase().includes(search));
    }

    const total = filtered.length;
    const totalPages = Math.ceil(total / limit);
    const start = (page - 1) * limit;
    const items = filtered.slice(start, start + limit);

    res.json({
      code: 200,
      message: 'Fetch project subject categories successfully',
      data: {
        subject_area: subjectArea,
        items: items.map(c => ({
          subject_category_id: c.id,
          display_name: c.name,
        })),
        pagination: {
          page,
          limit,
          total,
          total_pages: totalPages,
        },
      },
    });
  } catch (err) {
    console.error('Error in fetchProjectSubjectCategories:', err);
    if (err.status) {
      return res.status(err.status).json({ code: err.status, message: err.message, data: null });
    }
    next(err);
  }
}
