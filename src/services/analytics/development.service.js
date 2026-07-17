import { getResolvedScope } from './scope.repository.js';
import { getPublicationTrendsData } from './publication.service.js';
import { getCitationMirroringData } from './citation.service.js';
import { getTopicEvolutionData } from './topic.service.js';
import { getFrontierDetectionData } from './frontier.service.js';
import { getForecastData } from './forecast.service.js';
import logger from '../../utils/logger.js';

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
  const startTotal = Date.now();
  logger.info(`[Analytics] Starting development trends orchestrator for project ${query.project_id || 'all'}`);

  // 1. Resolve highly-cached scope
  const scopeStart = Date.now();
  const scope = await getResolvedScope(query);
  logger.info(`[Analytics] Scope resolution took ${Date.now() - scopeStart}ms`);

  const timeframeQuery = parseTimeframe(query.timeframe);

  // 2. Parallel execution of all 5 independent modules
  const modulesStart = Date.now();
  const [
    publicationTrend,
    citationMirroring,
    topicEvolution,
    frontierDetection,
    forecastInsights
  ] = await Promise.all([
    getPublicationTrendsData(scope, timeframeQuery),
    getCitationMirroringData(scope, timeframeQuery),
    getTopicEvolutionData(scope, timeframeQuery),
    getFrontierDetectionData(scope),
    getForecastData(scope)
  ]);
  logger.info(`[Analytics] Parallel modules execution took ${Date.now() - modulesStart}ms`);

  const responseData = {
    publicationTrend,
    citationMirroring,
    topicEvolution,
    frontierDetection,
    forecastInsights
  };

  logger.info(`[Analytics] Total orchestrator time: ${Date.now() - startTotal}ms`);
  
  return responseData;
}
