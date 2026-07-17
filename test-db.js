import { getPublicationTrendData, getTopicEvolutionData, getCitationMirroringData, getFrontierDetectionData, getForecastInsightsData } from './src/services/developmentTrends.service.js';

async function run() {
  const query = { project_id: '11' };

  console.time('Publication Trend');
  await getPublicationTrendData(query);
  console.timeEnd('Publication Trend');

  console.time('Topic Evolution');
  await getTopicEvolutionData(query);
  console.timeEnd('Topic Evolution');

  console.time('Citation Mirroring');
  await getCitationMirroringData(query);
  console.timeEnd('Citation Mirroring');

  console.time('Frontier Detection');
  await getFrontierDetectionData(query);
  console.timeEnd('Frontier Detection');

  console.time('Forecast Insights');
  await getForecastInsightsData(query);
  console.timeEnd('Forecast Insights');

  process.exit(0);
}

run();
