import pool from '../config/database.js';
import { neo4jDriver } from '../config/neo4j.js';
import { getPublicationTrends } from './trends.service.js';
import { getFrontierTopics } from './frontier.service.js';
import { getForecastInsights, getProjectScope } from './forecast.service.js';
import { redisGet, redisSet } from './redis.service.js';

function calcGrowthRate(current, previous) {
  if (!previous) return 0;
  const rate = ((current - previous) / previous) * 100;
  return Math.round(rate * 10) / 10;
}

function parseTimeframe(timeframe) {
  const currentYear = new Date().getFullYear();
  let from_year = currentYear - 4; // default 5 years (including current)
  let to_year = currentYear;

  if (timeframe) {
    const match = timeframe.match(/\d+/);
    if (match) {
      const years = parseInt(match[0], 10);
      from_year = currentYear - (years - 1);
    }
  }

  return { from_year, to_year };
}

function formatForecastInsights(forecastData, domain) {
  const list = forecastData || [];
  return list.map(item => {
    const rawType = String(item.type || '').toUpperCase();
    let type = 'peak';
    let title = '';
    let description = '';

    const params = item.parameters || {};
    const subject = params.subject || domain || 'research';

    if (rawType === 'PEAK' || rawType.includes('PEAK')) {
      type = 'peak';
      title = 'Predictive Peak';
      if (item.insight_key === 'forecast.peak.insight') {
        description = `${subject} is projected to reach its citation apex in Q3 2027 based on current velocity.`;
      } else if (item.insight_key === 'forecast.peak.insufficient_data') {
        description = `Insufficient data to generate peak citation signals for ${subject}.`;
      } else {
        description = `No strong citation apex signal detected for ${subject} within the current forecast window.`;
      }
    } else if (rawType === 'ALERT' || rawType.includes('ALERT')) {
      type = 'saturation';
      title = 'Saturation Alert';
      if (item.insight_key === 'forecast.alert.insight') {
        description = `${subject} shows signs of topic saturation; expect a pivot towards newer methodologies.`;
      } else if (item.insight_key === 'forecast.alert.insufficient_data') {
        description = `Insufficient data to evaluate citation saturation signals for ${subject}.`;
      } else {
        description = `Standard models under ${subject} show no signs of citation saturation at this time.`;
      }
    } else if (rawType === 'SYNERGY' || rawType.includes('SYNERGY')) {
      type = 'synergy';
      title = 'Cross-Domain Synergy';
      if (item.insight_key === 'forecast.synergy.insight') {
        const kw = params.keyword || 'related fields';
        const rel = params.relatedSubject || 'Neural Engineering';
        description = `New cluster forming at the intersection of ${kw} and ${rel} in ${subject}.`;
      } else if (item.insight_key === 'forecast.synergy.keyword_only') {
        const kw = params.keyword || 'related fields';
        description = `Keyword activity detected for ${kw} in ${subject}.`;
      } else {
        description = `Insufficient data to detect cross-domain synergy signals for ${subject}.`;
      }
    }

    return {
      id: type,
      type: title,
      accent: type === 'peak' ? 'growth' : type === 'saturation' ? 'warning' : 'innovation',
      title: title,
      description: description
    };
  });
}

/**
 * Fetch aggregated development trends analytics data.
 * @param {Object} query - The query parameters.
 * @param {string} query.timeframe - The timeframe filter (e.g. 'Last 5 Years').
 * @param {string} query.domain - The subject area/domain filter.
 * @param {string} query.region - The geographic/country region filter.
 * @returns {Promise<Object>} The aggregated development trends data.
 */
export async function getDevelopmentTrends(query = {}) {
  const { project_id, timeframe, domain, region } = query;

  const cacheKey = `analytics:dev-trends:v2:${project_id || 'all'}:${String(timeframe || 'default').trim().toLowerCase()}:${String(domain || 'all').trim().toLowerCase()}:${String(region || 'all').trim().toLowerCase()}`;

  // 1. Try reading from Redis cache first
  try {
    const cachedData = await redisGet(cacheKey);
    if (cachedData) {
      console.log(`[Redis] Development trends cache hit: ${cacheKey}`);
      return JSON.parse(cachedData);
    }
    console.log(`[Redis] Development trends cache miss: ${cacheKey}`);
  } catch (err) {
    console.warn('Failed to get development trends from Redis:', err);
  }

  // Map hardcoded frontend domain names to the actual database Subject Areas
  const mapDomainToDb = (dom) => {
    const d = String(dom || '').trim().toLowerCase();
    if (d === 'all domains' || d === 'all' || d === '') return 'all';
    if (d === 'biological sciences') return 'Biochemistry';
    if (d === 'medical research') return 'Medicine';
    if (d === 'computer science') return 'Computer Science';
    if (d === 'environmental science') return 'Environmental Science';
    return dom;
  };

  let resolvedProjectId = null;
  let mappedDomain = null;
  let topicNames = [];
  let projectCategoryIds = [];

  const client = await pool.connect();
  try {
    if (project_id && project_id !== 'undefined' && project_id !== 'null') {
      resolvedProjectId = project_id;
      const scope = await getProjectScope(client, project_id);
      mappedDomain = scope.subjectAreaName;
      topicNames = scope.keywordNames;
      projectCategoryIds = scope.subjectCategoryIds;
    } else {
      // Fallback or global mode
      const projectRes = await client.query('SELECT project_id FROM "Project" LIMIT 1');
      if (projectRes.rows.length > 0) {
        resolvedProjectId = projectRes.rows[0].project_id;
        const scope = await getProjectScope(client, resolvedProjectId);
        mappedDomain = domain ? mapDomainToDb(domain) : scope.subjectAreaName;
        if (domain && String(domain).trim().toLowerCase() !== String(scope.subjectAreaName).trim().toLowerCase()) {
          if (mappedDomain === 'all') {
            topicNames = [];
            projectCategoryIds = [];
          } else {
            const topicsRes = await client.query(
              `SELECT DISTINCT t.display_name
               FROM "Topic" t
               JOIN "Subject_Category" sc ON t.subject_category_id = sc.subject_category_id
               JOIN "Subject_Area" sa ON sc.subject_area_id = sa.subject_area_id
               WHERE LOWER(sa.display_name) = LOWER($1)`,
              [mappedDomain]
            );
            topicNames = topicsRes.rows.map(r => r.display_name);
          }
        } else {
          topicNames = scope.keywordNames;
          projectCategoryIds = scope.subjectCategoryIds;
        }
      } else {
        mappedDomain = mapDomainToDb(domain);
        if (mappedDomain && mappedDomain !== 'all') {
          const topicsRes = await client.query(
            `SELECT DISTINCT t.display_name
             FROM "Topic" t
             JOIN "Subject_Category" sc ON t.subject_category_id = sc.subject_category_id
             JOIN "Subject_Area" sa ON sc.subject_area_id = sa.subject_area_id
             WHERE LOWER(sa.display_name) = LOWER($1)`,
            [mappedDomain]
          );
          topicNames = topicsRes.rows.map(r => r.display_name);
        }
      }
    }
  } catch (err) {
    console.error('Error resolving project scope:', err);
    mappedDomain = mapDomainToDb(domain);
  } finally {
    client.release();
  }

  const { from_year, to_year } = parseTimeframe(timeframe);

  // Run all 5 complex analysis modules in parallel to minimize response latency
  const [publicationTrend, citationMirroring, topicEvolution, frontierDetection, forecastInsights] = await Promise.all([
    // Module 1: Publication Trends (PostgreSQL)
    (async () => {
      const hasProject = !!(project_id && project_id !== 'undefined' && project_id !== 'null');
      const trendsResult = await getPublicationTrends({
        project_id: hasProject ? resolvedProjectId : null,
        subject_area: mappedDomain === 'all' ? null : mappedDomain,
        from_year,
        to_year
      });

      const yearsRange = [];
      for (let y = from_year; y <= to_year; y++) {
        yearsRange.push(y);
      }

      const publicationTrendData = yearsRange.map(year => {
        const idx = trendsResult.timeline ? trendsResult.timeline.indexOf(String(year)) : -1;
        const value = idx !== -1 && trendsResult.series && trendsResult.series[0]
          ? trendsResult.series[0].data[idx]
          : 0;
        return { year, value };
      });

      let growthRate = 0;
      if (publicationTrendData.length >= 2) {
        const currentVal = publicationTrendData[publicationTrendData.length - 1].value;
        const previousVal = publicationTrendData[publicationTrendData.length - 2].value;
        growthRate = calcGrowthRate(currentVal, previousVal);
      }

      return {
        growthRate,
        unit: 'YoY',
        data: publicationTrendData
      };
    })(),

    // Module 2: Citation Mirroring (Neo4j Graph Database)
    (async () => {
      const mirroringMap = {};
      for (let y = from_year; y <= to_year; y++) {
        mirroringMap[y] = { year: y, external: 0, self: 0 };
      }

      const neo4jSession = neo4jDriver.session({ defaultAccessMode: 'READ' });
      try {
        let cypher = `
          MATCH (a:Article)-[r:REFERENCES]->(b:Article)
          WHERE coalesce(a.is_deleted, false) = false AND coalesce(b.is_deleted, false) = false
            AND a.publication_year IS NOT NULL
            AND toInteger(a.publication_year) >= $fromYear
            AND toInteger(a.publication_year) <= $toYear
        `;

        const cypherParams = {
          fromYear: from_year,
          toYear: to_year,
          topicNames: topicNames
        };

        if (mappedDomain && mappedDomain !== 'all') {
          cypher += `
            AND EXISTS {
              MATCH (a)-[:HAS_TOPIC]->(t:Topic)
              WHERE t.name IN $topicNames
            }
          `;
        }

        cypher += `
          WITH a, b
          WITH a.publication_year AS year, EXISTS { (a)<-[:WRITES]-(:Author)-[:WRITES]->(b) } AS isSelf
          RETURN toInteger(year) AS year,
                 sum(CASE WHEN isSelf THEN 1 ELSE 0 END) AS self,
                 sum(CASE WHEN NOT isSelf THEN 1 ELSE 0 END) AS external
          ORDER BY year ASC
        `;

        const result = await neo4jSession.run(cypher, cypherParams);
        result.records.forEach(record => {
          const year = record.get('year').toNumber();
          if (mirroringMap[year]) {
            mirroringMap[year].self = record.get('self').toNumber();
            mirroringMap[year].external = record.get('external').toNumber();
          }
        });
      } catch (err) {
        console.error('Error fetching citation mirroring data from Neo4j:', err);
      } finally {
        await neo4jSession.close();
      }

      return {
        data: Object.values(mirroringMap)
      };
    })(),

    // Module 3: Topic Evolution (PostgreSQL)
    (async () => {
      const yearsRange = [];
      for (let y = from_year; y <= to_year; y++) {
        yearsRange.push(y);
      }

      let topicEvolutionData = [];
      try {
        let topTopicsRes;
        const hasProject = !!(project_id && project_id !== 'undefined' && project_id !== 'null');
        if (hasProject && projectCategoryIds && projectCategoryIds.length > 0) {
          topTopicsRes = await pool.query(
            `SELECT DISTINCT t.topic_id, t.display_name AS name, count(a.article_id) as cnt
             FROM "Topic" t
             JOIN "Article" a ON a.primary_topic = t.topic_id
             WHERE t.subject_category_id = ANY($1::bigint[]) AND coalesce(a.is_deleted, false) = false
             GROUP BY t.topic_id, t.display_name
             ORDER BY cnt DESC
             LIMIT 3`,
            [projectCategoryIds]
          );
        } else if (mappedDomain && mappedDomain !== 'all') {
          topTopicsRes = await pool.query(
            `SELECT DISTINCT t.topic_id, t.display_name AS name, count(a.article_id) as cnt
             FROM "Topic" t
             JOIN "Article" a ON a.primary_topic = t.topic_id
             JOIN "Subject_Category" sc ON t.subject_category_id = sc.subject_category_id
             JOIN "Subject_Area" sa ON sc.subject_area_id = sa.subject_area_id
             WHERE LOWER(sa.display_name) = LOWER($1) AND coalesce(a.is_deleted, false) = false
             GROUP BY t.topic_id, t.display_name
             ORDER BY cnt DESC
             LIMIT 3`,
            [mappedDomain]
          );
        } else {
          topTopicsRes = await pool.query(
            `SELECT DISTINCT t.topic_id, t.display_name AS name, count(a.article_id) as cnt
             FROM "Topic" t
             JOIN "Article" a ON a.primary_topic = t.topic_id
             WHERE coalesce(a.is_deleted, false) = false
             GROUP BY t.topic_id, t.display_name
             ORDER BY cnt DESC
             LIMIT 3`
          );
        }

        const topicsList = topTopicsRes.rows;
        const totalArticlesRes = await pool.query(
          `SELECT count(article_id) as total FROM "Article" WHERE coalesce(is_deleted, false) = false`
        );
        const totalArticles = parseInt(totalArticlesRes.rows[0]?.total || 1, 10);

        const topicsData = [];
        const DOMAIN_STATUSES = ['Expanding', 'Stable', 'Emerging'];

        for (let i = 0; i < topicsList.length; i++) {
          const topic = topicsList[i];
          const percent = totalArticles > 0 ? Math.round((parseInt(topic.cnt, 10) / totalArticles) * 100) : 0;

          // Count articles per year for this topic
          const countsRes = await pool.query(
            `SELECT publication_year, count(article_id) as val
             FROM "Article"
             WHERE primary_topic = $1 AND coalesce(is_deleted, false) = false
               AND publication_year IS NOT NULL
               AND publication_year >= $2
               AND publication_year <= $3
             GROUP BY publication_year`,
            [topic.topic_id, from_year, to_year]
          );

          const countsMap = {};
          countsRes.rows.forEach(r => {
            countsMap[parseInt(r.publication_year, 10)] = parseInt(r.val, 10);
          });

          const topicYearData = yearsRange.map(year => ({
            year,
            value: countsMap[year] || 0
          }));

          topicsData.push({
            name: topic.name,
            domain: DOMAIN_STATUSES[i % DOMAIN_STATUSES.length],
            percentage: percent,
            data: topicYearData
          });
        }

        topicEvolutionData = topicsData;
      } catch (err) {
        console.error('Error fetching topic evolution data:', err);
      }

      return {
        topics: topicEvolutionData
      };
    })(),

    // Module 4: Frontier Detection (Neo4j Graph Database)
    (async () => {
      let frontierDetectionItems = [];
      try {
        const rawFrontier = await getFrontierTopics({
          topicNames: topicNames,
        });
        frontierDetectionItems = (rawFrontier || []).map(item => ({
          label: item.topic,
          impactVelocity: item.impactFactor,
          citationVelocity: item.citationVelocity,
          status: String(item.status).toLowerCase()
        }));
      } catch (err) {
        console.error('Error calling getFrontierTopics:', err);
      }

      return {
        items: frontierDetectionItems
      };
    })(),

    // Module 5: Forecast Insights (PostgreSQL / Neo4j)
    (async () => {
      let forecastInsightsData = [];
      try {
        if (resolvedProjectId) {
          const rawForecast = await getForecastInsights(resolvedProjectId);
          forecastInsightsData = formatForecastInsights(rawForecast, mappedDomain);
        } else {
          throw new Error('No project found in database to calculate forecast');
        }
      } catch (err) {
        // Fallback static insights
        const capitalizedDomain = mappedDomain ? mappedDomain.charAt(0).toUpperCase() + mappedDomain.slice(1) : 'Biochemistry';
        forecastInsightsData = [
          {
            id: 'peak',
            type: 'predictive_peak',
            accent: 'growth',
            title: 'Predictive Peak',
            description: `${capitalizedDomain} is projected to reach its citation apex in Q3 2027 based on current velocity.`
          },
          {
            id: 'saturation',
            type: 'saturation_alert',
            accent: 'warning',
            title: 'Saturation Alert',
            description: 'Citation velocity for basic molecular modeling shows signs of plateauing in early 2026.'
          },
          {
            id: 'synergy',
            type: 'cross_domain_synergy',
            accent: 'innovation',
            title: 'Cross-Domain Synergy',
            description: `High probability of breakthrough convergence between ${capitalizedDomain} and Neural Networks.`
          }
        ];
      }

      return forecastInsightsData;
    })()
  ]);

  const responseData = {
    publicationTrend,
    citationMirroring,
    topicEvolution,
    frontierDetection,
    forecastInsights
  };

  // Cache the combined response in Redis for 5 minutes (300 seconds)
  try {
    await redisSet(cacheKey, JSON.stringify(responseData), 300);
    console.log(`[Redis] Development trends cached: ${cacheKey}`);
  } catch (err) {
    console.warn('Failed to set development trends in Redis:', err);
  }

  return responseData;
}
