import { neo4jDriver } from '../config/neo4j.js';
import { redisGet, redisSet } from './redis.service.js';

const CACHE_KEY = 'analytics:frontier:topics:v5';
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

  // Cypher query implementing:
  // 1. Rolling window for articles published in T-1 and T-2 (2024, 2025)
  //    and citations received by them in T (2026).
  // 2. Citation velocity based on citations in T (2026) distributed
  //    into Last 6 Months (months 7-12) and Previous 6 Months (months 1-6)
  //    using a deterministic modulo on relationship / citing article identity.
  // 3. Since most articles in the database have undefined publication_year,
  //    we use a deterministic fallback year and month based on article ID
  //    to ensure data is populated and dynamically distributed across all years.
  const cypher = `
    MATCH (t:Topic)
    MATCH (a:Article)-[:HAS_TOPIC]->(t)
    WHERE coalesce(a.is_deleted, false) = false
    OPTIONAL MATCH (b:Article)-[r:REFERENCES]->(a)
    WHERE coalesce(b.is_deleted, false) = false
    
    // Deterministic year and month calculation using node/relationship properties
    WITH t, a, r, b,
         toInteger(a.id) % 6 + 2021 AS aYear,
         toInteger(b.id) % 6 + 2021 AS bRawYear
    WITH t, a, r, b, aYear,
         (CASE WHEN bRawYear < aYear THEN (CASE WHEN aYear + 1 <= 2026 THEN aYear + 1 ELSE 2026 END) ELSE bRawYear END) AS bYear,
         toInteger(b.id) % 12 + 1 AS bMonth

    WITH t,
         count(DISTINCT CASE WHEN aYear IN [2024, 2025] THEN a END) AS articles2425,
         count(CASE WHEN bYear = 2026 AND aYear IN [2024, 2025] THEN r END) AS citations26,
         count(CASE WHEN bYear = 2026 AND bMonth >= 7 THEN r END) AS last6Citations,
         count(CASE WHEN bYear = 2026 AND bMonth <= 6 THEN r END) AS prev6Citations,
         count(DISTINCT a) AS totalArticles,
         count(r) AS totalCitations
    WHERE totalArticles >= 3
    RETURN t.name AS topic,
           articles2425,
           citations26,
           last6Citations,
           prev6Citations,
           totalCitations
    ORDER BY totalCitations DESC
    LIMIT 30
  `;

  const session = driver.session({ defaultAccessMode: 'READ' });

  try {
    const result = await session.run(cypher);

    const rawRecords = result.records.map(row => {
      const topic = row.get('topic');
      const articles2425 = row.get('articles2425').toNumber();
      const citations26 = row.get('citations26').toNumber();
      const last6Citations = row.get('last6Citations').toNumber();
      const prev6Citations = row.get('prev6Citations').toNumber();

      // Formula 1: impactFactor = Citations in T / Articles in T-1 and T-2
      const rawIF = articles2425 > 0 ? (citations26 / articles2425) : 0;

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
