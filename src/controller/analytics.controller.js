/**
 * Express controller for analytics endpoints.
 */
import logger from '../utils/logger.js';
import { z } from 'zod';
import { getTopEntities } from "../services/dashboard/analytics.service.js";
import { getPublicationTrends } from "../services/trends/trends.service.js";
import { getFrontierTopics } from "../services/trends/frontier.service.js";
import { getDistribution } from "../services/trends/distribution.service.js";
import { getForecastInsights } from "../services/trends/forecast.service.js";
import { getGeoDistribution } from "../services/trends/geoDistribution.service.js";
import { getImpactQuartiles } from '../services/metrics/impactQuartiles.service.js';
import { getCollaborationNetwork } from '../services/collaboration/network.service.js';
import { getJournalQuartileDistribution } from "../services/journals/journal-quartile.service.js";
import { getJournalRanking } from "../services/journals/journal-ranking.service.js";
import { getTopicIntensityMatrix } from '../services/metrics/matrix.service.js';
import { getInfluentialRankings } from "../services/metrics/rankings.service.js";
import { getProductivityMatrix } from "../services/metrics/productivityMatrix.service.js";
import { getCountryCollaborationChord } from "../services/collaboration/countryCollaboration.service.js";
import { getJournalMigrationAnalysis } from '../services/journals/migration.service.js';
import { getNetworkTopology } from '../services/collaboration/topology.service.js';
import { getKeywordVectors } from '../services/trends/keywordVectors.service.js';
import { getDashboardSearchSuggestions } from '../services/search/dashboardSearch.service.js';
import { getDevelopmentTrends } from '../services/analytics/development.service.js';
import { getImpactMatrixData } from '../services/metrics/impactMatrix.service.js';
import { getCrossLinks } from '../services/collaboration/crossLinks.service.js';
import { getTemporalShift } from '../services/trends/temporalShift.service.js';
import { getCollaborationInsights, getCollaborationMetrics } from '../services/collaboration/collabInsights.service.js';
import { getCuratedArticles, getProjectKeywords, getTrackedJournals, addProjectKeyword, removeProjectKeyword } from '../services/journals/curatedArticles.service.js';





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
      project_id: String(project_id),
      subject_area: subject_area ? String(subject_area) : undefined,
      keywords: keywords ? String(keywords) : undefined,
      from_year: from_year,
      to_year: to_year,
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
    const { project_id, subject_area, keywords, from_year, to_year, page, limit } = req.validatedQuery;

    const data = await getJournalRanking({
      project_id: String(project_id),
      subject_area: subject_area ? String(subject_area) : undefined,
      keywords: keywords ? String(keywords) : undefined,
      from_year: from_year,
      to_year: to_year,
      page: page,
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
 * Fetch Journal Impact Matrix (SJR vs H-Index).
 *
 * Route: GET /analytics/journals/impact-matrix
 */
export async function fetchImpactMatrix(req, res, next) {
  try {
    const { project_id, subject_area, keywords, from_year, to_year, limit } = req.validatedQuery;
    const filters = { projectId: project_id, subjectArea: subject_area, keywords, fromYear: from_year, toYear: to_year, limit };
    
    const data = await getImpactMatrixData(filters);

    return res.json({
      code: 200,
      message: "Fetch impact matrix data successfully",
      data,
    });
  } catch (error) {
    logger.error("Error in fetchImpactMatrix:", error);
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
    const { project_id: projectId, country, subject_area, keywords, from_year, to_year } = req.validatedQuery;

    const filters = {
      country,
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

/**
 * Lấy danh sách Subject Categories của một project.
 * Route: GET /analytics/subject-categories
 */
export async function fetchProjectSubjectCategories(req, res, next) {
  try {
    const filters = {
      projectId: req.validatedQuery.project_id,
      page: req.validatedQuery.page,
      limit: req.validatedQuery.limit,
      search: req.validatedQuery.search,
    };

    const { getProjectSubjectCategories } = await import('../services/dashboard/analytics.service.js');
    const data = await getProjectSubjectCategories(filters);

    res.json({
      code: 200,
      message: 'Fetch project subject categories successfully',
      data,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ code: err.status, message: err.message, data: null });
    }
    next(err);
  }
}

export async function fetchCollaborationInsights(req, res, next) {
  try {
    const { project_id } = req.validatedQuery;
    const data = await getCollaborationInsights(project_id, req.validatedQuery);
    res.json({
      code: 200,
      message: 'Fetch collaboration insights successfully',
      data
    });
  } catch (err) {
    next(err);
  }
}

export async function fetchCollaborationMetrics(req, res, next) {
  try {
    const { project_id } = req.validatedQuery;
    const data = await getCollaborationMetrics(project_id, req.validatedQuery);
    res.json({
      code: 200,
      message: 'Fetch collaboration metrics successfully',
      data
    });
  } catch (err) {
    next(err);
  }
}

export async function exportCollaborationReport(req, res, next) {
  try {
    const { project_id } = req.validatedQuery;
    const filters = req.validatedQuery;
    
    // Fetch all necessary data concurrently
    const [rankings, metrics, network] = await Promise.all([
      getInfluentialRankings(project_id, filters),
      getCollaborationMetrics(project_id, filters),
      getCollaborationNetwork(filters)
    ]);

    let csv = '';
    const projectId = project_id || 'all';

    // 1. KEY INSIGHTS
    csv += '--- KEY INSIGHTS ---\n';
    csv += 'Metric,Value\n';
    if (metrics && metrics.metrics) {
      metrics.metrics.forEach(m => {
        csv += `"${m.label}","${m.value}"\n`;
      });
    } else {
      csv += 'No insights data available,\n';
    }
    csv += '\n';

    // 2. TOP INFLUENTIAL AUTHORS
    csv += '--- TOP INFLUENTIAL AUTHORS ---\n';
    csv += 'Rank,Name,Impact Score\n';
    if (rankings && rankings.authors && rankings.authors.length > 0) {
      rankings.authors.forEach(a => {
        csv += `${a.rank},"${a.name}",${a.score}\n`;
      });
    } else {
      csv += 'No top authors available,,\n';
    }
    csv += '\n';

    // 3. LEADING INSTITUTIONS
    csv += '--- LEADING INSTITUTIONS ---\n';
    csv += 'Rank,Name,Citations\n';
    if (rankings && rankings.institutions && rankings.institutions.length > 0) {
      rankings.institutions.forEach(i => {
        csv += `${i.rank},"${i.name}",${i.score}\n`;
      });
    } else {
      csv += 'No leading institutions available,,\n';
    }
    csv += '\n';

    // 4. GLOBAL COLLABORATION NETWORK
    csv += '--- GLOBAL COLLABORATION NETWORK ---\n';
    csv += 'Name,Type,Articles/Affiliations,Label\n';
    if (network && network.nodes && network.nodes.length > 0) {
      network.nodes.forEach(node => {
        const type = node.type === 'AUTHOR' ? 'Author' : 'Institution';
        const metric = node.size || node.val || 0;
        csv += `"${node.id}","${type}",${metric},"${node.label || node.id}"\n`;
      });
    } else {
      csv += 'No network nodes available,,,\n';
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="collaboration_analytics_report_${projectId}.csv"`);
    return res.status(200).send(Buffer.from('\uFEFF' + csv, 'utf-8')); // Add BOM for Excel UTF-8 compatibility
  } catch (err) {
    logger.error(`Error exporting collaboration report: ${err.message}`, err);
    next(err);
  }
}

export async function exportCountryCollaborationMatrix(req, res, next) {
  try {
    const data = await getCountryCollaborationChord(req.validatedQuery);
    
    let csv = '\uFEFFSource Country,Target Country,Co-Authorship Count,Growth Rate\n';
    if (Array.isArray(data) && data.length > 0) {
      data.forEach(row => {
        const source = `"${(row.source || '').replace(/"/g, '""')}"`;
        const target = `"${(row.target || '').replace(/"/g, '""')}"`;
        const count = row.coAuthorshipValue || 0;
        const growth = `"${(row.growth || '+0%').replace(/"/g, '""')}"`;
        csv += `${source},${target},${count},${growth}\n`;
      });
    }
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="country_collaboration_matrix.csv"');
    return res.status(200).send(csv);
  } catch (err) {
    next(err);
  }
}

export async function fetchCrossLinks(req, res, next) {
  try {
    const { project_id } = req.validatedQuery;
    const data = await getCrossLinks(project_id, req.validatedQuery);
    res.json({
      code: 200,
      message: 'Fetch cross links successfully',
      data
    });
  } catch (err) {
    next(err);
  }
}

export async function fetchTemporalShift(req, res, next) {
  try {
    const { project_id } = req.validatedQuery;
    const data = await getTemporalShift(project_id, req.validatedQuery);
    res.json({
      code: 200,
      message: 'Fetch temporal shift successfully',
      data
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Fetch Curated Articles for a project.
 */
export async function fetchCuratedArticles(req, res, next) {
  try {
    const { project_id, subject_area, keywords, from_year, to_year, page, limit, is_open_access } = req.validatedQuery;

    const data = await getCuratedArticles(project_id, {
      subject_area,
      keywords,
      from_year,
      to_year,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 10,
      is_open_access
    });

    res.status(200).json({
      code: 200,
      message: 'Fetch curated articles successfully',
      data,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Fetch Project Keywords.
 */
export async function fetchProjectKeywords(req, res, next) {
  try {
    const { project_id } = req.validatedQuery;
    const data = await getProjectKeywords(project_id);

    res.status(200).json({
      code: 200,
      message: 'Fetch project keywords successfully',
      data,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Add a Keyword to a Project.
 */
export async function addProjectKeywordHandler(req, res, next) {
  try {
    const { project_id } = req.validatedQuery;
    const { keyword } = req.body;
    if (!keyword) {
      return res.status(400).json({ code: 400, message: 'keyword is required' });
    }
    const data = await addProjectKeyword(project_id, keyword);
    res.status(200).json({
      code: 200,
      message: 'Add project keyword successfully',
      data,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Remove a Keyword from a Project.
 */
export async function removeProjectKeywordHandler(req, res, next) {
  try {
    const { project_id } = req.validatedQuery;
    const { keyword_id } = req.params;
    if (!keyword_id) {
      return res.status(400).json({ code: 400, message: 'keyword_id is required' });
    }
    await removeProjectKeyword(project_id, keyword_id);
    res.status(200).json({
      code: 200,
      message: 'Remove project keyword successfully',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Fetch Tracked Journals.
 */
export async function fetchTrackedJournals(req, res, next) {
  try {
    const { project_id } = req.validatedQuery;
    const data = await getTrackedJournals(project_id);

    res.status(200).json({
      code: 200,
      message: 'Fetch tracked journals successfully',
      data,
    });
  } catch (error) {
    next(error);
  }
}
