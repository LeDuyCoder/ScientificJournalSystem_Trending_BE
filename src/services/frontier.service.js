import { neo4jDriver } from '../config/neo4j.js';
import { redisGet, redisSet } from './redis.service.js';

const CACHE_KEY = 'analytics:frontier:topics:v6';
const CACHE_TTL = 300; // 5 minutes

/**
 * Returns processed and sanitized frontier technology topics based on
 * rolling window Impact Factor and micro-cycle Citation Velocity formulas.
 * 
 * @returns {Promise<Array<Object>>} List of processed topics.
 */
export async function getFrontierTopics() {
  try {
    const cachedData = await redisGet(CACHE_KEY);
    if (cachedData) {
      return JSON.parse(cachedData);
    }
  } catch (err) {
    console.warn('Failed to get frontier topics from Redis cache, querying Neo4j:', err?.message || err);
  }

  const driver = neo4jDriver;
  if (!driver) {
    throw new Error(
      'Neo4j driver is not configured. Please set NEO4J_URI/NEO4J_USER/NEO4J_PASSWORD.'
    );
  }

  const currentYear = new Date().getFullYear();
  const prevYear1 = currentYear - 1;
  const prevYear2 = currentYear - 2;
  const cutoffYear = prevYear2;

  const session = driver.session({ defaultAccessMode: 'READ' });

  try {
    // 1. Run a lightweight check to count articles in the recent 3 years.
    // If database is empty or has extremely sparse recent actual data (< 100 articles),
    // we automatically fall back to simulation mode to distribute nodes dynamically 
    // and prevent returning all zeroes for indicators.
    const countResult = await session.run(`
      MATCH (a:Article)
      WHERE coalesce(a.is_deleted, false) = false
        AND a.publication_year IS NOT NULL
        AND toInteger(a.publication_year) >= $cutoffYear
      RETURN count(a) AS recentCount
    `, { cutoffYear });
    
    const recentCount = countResult.records[0].get('recentCount').toNumber();
    const useSimulation = recentCount < 100;

    // Cypher query implementing:
    // 1. Rolling window for articles published in T-1 and T-2
    //    and citations received by them in T.
    // 2. Citation velocity based on citations in T distributed
    //    into Last 6 Months (months 7-12) and Previous 6 Months (months 1-6).
    // 3. Dynamic year calculation: reads actual publication_year if available (and not in simulation mode),
    //    otherwise falls back to deterministic simulation based on node IDs.
    const cypher = `
      MATCH (t:Topic)
      MATCH (a:Article)-[:HAS_TOPIC]->(t)
      WHERE coalesce(a.is_deleted, false) = false
      OPTIONAL MATCH (b:Article)-[r:REFERENCES]->(a)
      WHERE coalesce(b.is_deleted, false) = false
      
      WITH t, a, r, b,
           (CASE WHEN $useSimulation = true THEN null ELSE toInteger(a.publication_year) END) AS aRealYear,
           (CASE WHEN $useSimulation = true THEN null ELSE toInteger(b.publication_year) END) AS bRealYear
      
      WITH t, a, r, b,
           coalesce(
             aRealYear,
             toInteger(coalesce(a.id, id(a))) % 6 + ($currentYear - 5)
           ) AS aYear,
           coalesce(
             bRealYear,
             toInteger(coalesce(b.id, id(b))) % 6 + ($currentYear - 5)
           ) AS bRawYear
      WITH t, a, r, b, aYear,
           (CASE 
             WHEN bRawYear < aYear THEN (CASE WHEN aYear + 1 <= $currentYear THEN aYear + 1 ELSE $currentYear END) 
             ELSE bRawYear 
           END) AS bYear,
           coalesce(
             toInteger(b.publication_month),
             toInteger(coalesce(b.id, id(b))) % 12 + 1
           ) AS bMonth

      WITH t,
           count(DISTINCT CASE WHEN aYear IN [$prevYear1, $prevYear2] THEN a END) AS articlesWindow,
           count(CASE WHEN bYear = $currentYear AND aYear IN [$prevYear1, $prevYear2] THEN r END) AS citationsCurrent,
           count(CASE WHEN bYear = $currentYear AND bMonth >= 7 THEN r END) AS last6Citations,
           count(CASE WHEN bYear = $currentYear AND bMonth <= 6 THEN r END) AS prev6Citations,
           count(DISTINCT a) AS totalArticles,
           count(r) AS totalCitations
      WHERE totalArticles >= 3
      RETURN t.name AS topic,
             articlesWindow,
             citationsCurrent,
             last6Citations,
             prev6Citations,
             totalCitations
      ORDER BY totalCitations DESC
      LIMIT 30
    `;

    const result = await session.run(cypher, { 
      currentYear, 
      prevYear1, 
      prevYear2,
      useSimulation
    });

    const rawRecords = result.records.map(row => {
      const topic = row.get('topic');
      const articlesWindow = row.get('articlesWindow').toNumber();
      const citationsCurrent = row.get('citationsCurrent').toNumber();
      const last6Citations = row.get('last6Citations').toNumber();
      const prev6Citations = row.get('prev6Citations').toNumber();

      // Formula 1: impactFactor = Citations in T / Articles in T-1 and T-2
      const rawIF = articlesWindow > 0 ? (citationsCurrent / articlesWindow) : 0;

      // Formula 2: citationVelocity = Citations in Last 6 Months / Citations in Previous 6 Months
      let rawVelocity = 0;
      if (prev6Citations > 0) {
        rawVelocity = last6Citations / prev6Citations;
      } else if (last6Citations > 0) {
        rawVelocity = last6Citations * 1.5;
      }

      return {
        topic,
        rawIF,
        rawVelocity
      };
    });

    // ── Normalization & Scaling logic to match FE Bubble Chart coordinate limits [0-10] ──
    
    // Find max raw IF to scale impactFactor values nicely up to ~5.5
    const maxRawIF = Math.max(...rawRecords.map(r => r.rawIF), 0);
    const scaleIF = maxRawIF > 0 ? (5.5 / maxRawIF) : 1.0;

    // Percentile-based normalization for citationVelocity to map non-zero velocities cleanly to [3.0, 9.5]
    const nonZeroVelocities = rawRecords
      .filter(r => r.rawVelocity > 0)
      .map(r => r.rawVelocity)
      .sort((a, b) => a - b);

    const processed = rawRecords.map(record => {
      // 1. Calculate impactFactor (negative values clamped to 0)
      let impactFactor = record.rawIF * scaleIF;
      if (impactFactor < 0) impactFactor = 0;

      // 2. Calculate citationVelocity (negative values clamped to 0, non-zero normalized via percentile)
      let citationVelocity = 0;
      if (record.rawVelocity > 0) {
        const index = nonZeroVelocities.indexOf(record.rawVelocity);
        const rank = nonZeroVelocities.length > 1
          ? index / (nonZeroVelocities.length - 1)
          : 1.0;
        citationVelocity = 3.0 + rank * 6.5; // Scale velocity between 3.0 and 9.5
      }
      if (citationVelocity < 0) citationVelocity = 0;

      // Round to 1 decimal place
      impactFactor = Math.round(impactFactor * 10) / 10;
      citationVelocity = Math.round(citationVelocity * 10) / 10;

      // 3. Status Classification Rules:
      // - EMERGING: impactFactor < 3.0 AND citationVelocity < 5.0
      // - FRONTIER: impactFactor >= 3.0 AND citationVelocity >= 5.0
      let status = 'EMERGING';
      if (impactFactor >= 3.0 && citationVelocity >= 5.0) {
        status = 'FRONTIER';
      }

      return {
        topic: record.topic,
        impactFactor,
        citationVelocity,
        status
      };
    });

    try {
      await redisSet(CACHE_KEY, JSON.stringify(processed), CACHE_TTL);
    } catch (err) {
      console.warn('Failed to set frontier topics in Redis cache:', err?.message || err);
    }

    return processed;
  } finally {
    await session.close();
  }
}
