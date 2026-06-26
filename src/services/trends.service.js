/**
 * Mock dataset — publication count and citation count per year.
 * Sorted ascending by year.
 *
 * @type {Array<{ year: string; articles: number; citations: number }>}
 */
import { neo4jDriver } from '../config/neo4j.js';
import { redisGet, redisSet } from './redis.service.js';

/**
 * Build the trend response payload from raw year-level records.
 *
 * Guarantees:
 *  - timeline is sorted ascending
 *  - every series has the same length as timeline
 *  - no null / undefined values (missing → 0)
 *
 * @param {Array<{ year: string; articles: number; citations: number }>} records
 * @returns {{ timeline: string[]; series: Array<{ name: string; data: number[] }> }}
 */
function buildTrendPayload(records) {
  if (!records || records.length === 0) {
    return { timeline: [], series: [] };
  }

  const sorted = [...records].sort((a, b) => a.year.localeCompare(b.year));

  const timeline = sorted.map((r) => r.year);

  const series = [
    {
      name: 'Articles',
      data: sorted.map((r) => (typeof r.articles === 'number' ? r.articles : 0)),
    },
    {
      name: 'Citations',
      data: sorted.map((r) => (typeof r.citations === 'number' ? r.citations : 0)),
    },
  ];

  return { timeline, series };
}

export async function getPublicationTrends() {
  const cacheKey = 'analytics:trends:publication_citation';

  try {
    const cachedData = await redisGet(cacheKey);
    if (cachedData) {
      return JSON.parse(cachedData);
    }
  } catch (err) {
    console.warn('Failed to get trend data from Redis, falling back to Neo4j:', err?.message || err);
  }

  const driver = neo4jDriver;

  if (!driver) {
    throw new Error(
      'Neo4j driver is not configured. Please set NEO4J_URI/NEO4J_USER/NEO4J_PASSWORD.'
    );
  }

  const cypher = `
    MATCH (a:Article)
    WHERE a.publication_year IS NOT NULL AND toString(a.publication_year) <> ''
    WITH toString(a.publication_year) AS year, a
    OPTIONAL MATCH (b:Article)-[r:REFERENCES]->(a)
    WITH year, count(DISTINCT a) AS articles, count(r) AS citations
    RETURN year, toInteger(articles) AS articles, toInteger(citations) AS citations
    ORDER BY year ASC
  `;

  const session = driver.session({ defaultAccessMode: 'READ' });

  try {
    const result = await session.run(cypher);

    const records = result.records.map((row) => ({
      year: row.get('year'),
      articles: row.get('articles').toNumber(),
      citations: row.get('citations').toNumber(),
    }));

    const finalData = buildTrendPayload(records);

    try {
      await redisSet(cacheKey, JSON.stringify(finalData), 180);
    } catch (err) {
      console.warn('Failed to set trend data in Redis:', err?.message || err);
    }

    return finalData;
  } finally {
    await session.close();
  }
}
