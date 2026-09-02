import { getResolvedScope } from './scope.repository.js';
import { getPublicationTrendsData } from './publication.service.js';
import { getCitationMirroringData } from './citation.service.js';
import { getTopicEvolutionData } from './topic.service.js';
import { getFrontierDetectionData } from './frontier.service.js';
import { getForecastData } from './forecast.service.js';
import { fetchWithCache } from './cache.service.js';
import logger from '../../../../utils/logger.js';

const CACHE_KEY_PREFIX = 'analytics:development-trends:v1';
const CACHE_TTL = 43200; // 12 hours

function parseTimeframe(timeframe) {
  const currentYear = new Date().getFullYear();
  let from_year = currentYear - 4; // default 5 years
  let to_year = currentYear;

  if (timeframe) {
    const match = String(timeframe).match(/\d+/);
    if (match) {
      const years = parseInt(match[0], 10);
      from_year = currentYear - (years - 1);
    }
  }

  return { from_year, to_year };
}

export async function getDevelopmentTrends(query = {}) {
  const cacheKey = `${CACHE_KEY_PREFIX}:${query.project_id || 'all'}:${query.timeframe || 'default'}:${query.domain || 'all'}:${query.subject_category || 'all'}:${query.region || 'global'}`;

  return fetchWithCache(cacheKey, CACHE_TTL, async () => {
    const startTotal = Date.now();
    logger.info(`[Analytics] Starting development trends orchestrator for project ${query.project_id || 'all'}`);

    // 1. Resolve highly-cached scope
    const scopeStart = Date.now();
    const scope = await getResolvedScope(query);
    logger.info(`[Analytics] Scope resolution took ${Date.now() - scopeStart}ms`);

    const timeframeQuery = parseTimeframe(query.timeframe);

    const moduleTimeouts = [
        { name: 'publication', fn: () => getPublicationTrendsData(scope, timeframeQuery), timeout: 30000 },
        { name: 'citations', fn: () => getCitationMirroringData(scope, timeframeQuery), timeout: 30000 },
        { name: 'topics', fn: () => getTopicEvolutionData(scope, timeframeQuery), timeout: 30000 },
        { name: 'frontier', fn: () => getFrontierDetectionData(scope), timeout: 30000 },
        { name: 'forecast', fn: () => getForecastData(scope), timeout: 15000 }  // Timeout after 15s
    ];

    const results = {};
    for (const module of moduleTimeouts) {
        try {
            results[module.name] = await Promise.race([
                module.fn(),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error(`${module.name} module timeout`)), module.timeout)
                )
            ]);
        } catch (err) {
            logger.warn(`[Analytics] ${module.name} module failed:`, err?.message);
            results[module.name] = module.name === 'forecast' ? [] : null;
        }
    }

    const publicationTrend = results.publication;
    const citationMirroring = results.citations;
    const topicEvolution = results.topics;
    const frontierDetection = results.frontier;
    const forecastInsights = results.forecast;

    const responseData = {
      publicationTrend,
      citationMirroring,
      topicEvolution,
      frontierDetection,
      forecastInsights
    };

    logger.info(`[Analytics] Total orchestrator time: ${Date.now() - startTotal}ms`);
    
    return responseData;
  });
}
