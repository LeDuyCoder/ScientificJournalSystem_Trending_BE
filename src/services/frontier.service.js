import { neo4jDriver } from '../config/neo4j.js';
import { redisGet, redisSet } from './redis.service.js';

const CACHE_KEY = 'analytics:frontier:topics:v6';
const CACHE_TTL = 30000; // 5 minutes

/**
 * Chuẩn bị và phân loại các bộ lọc thành ID và Tên chữ thường (case-insensitive)
 */
function prepareFilters(filters) {
  const subjectArea = filters.subjectArea || '';
  const keywords = filters.keywords || filters.keywordIds || [];

  const processFilterArray = (arr) => {
    const ids = [];
    const namesLower = [];
    for (const val of arr) {
      if (val === undefined || val === null || val === '') continue;
      if (typeof val === 'number') {
        ids.push(val);
      } else {
        const str = String(val).trim();
        const num = Number(str);
        if (!Number.isNaN(num) && String(num) === str) {
          ids.push(num);
        } else {
          namesLower.push(str.toLowerCase());
        }
        // Cũng đưa chuỗi gốc vào ids để hỗ trợ so khớp trực tiếp id kiểu chuỗi
        ids.push(str);
      }
    }
    return { ids, namesLower };
  };

  const kw = processFilterArray(keywords);

  return {
    subjectArea: typeof subjectArea === 'string' ? subjectArea.trim() : '',
    keywordIds: kw.ids,
    keywordNamesLower: kw.namesLower,
  };
}

/**
 * Returns processed and sanitized frontier technology topics based on
 * rolling window Impact Factor and micro-cycle Citation Velocity formulas.
 * 
 * @param {Object} [filters] - Optional filter object
 * @returns {Promise<Array<Object>>} List of processed topics.
 */
export async function getFrontierTopics(filters = {}) {
  const {
    subjectArea,
    keywordIds,
    keywordNamesLower,
  } = prepareFilters(filters);
  const topicNames = filters.topicNames || [];

  // 1. Build Redis cache key theo filter
  const filterParts = [];

  if (subjectArea) {
    filterParts.push(`subjectArea:${String(subjectArea).toLowerCase()}`);
  }

  if (topicNames.length > 0) {
    const sortedTopics = [...topicNames].sort().join(',');
    filterParts.push(`topicNames:${sortedTopics.toLowerCase()}`);
  }

  if (keywordIds.length > 0 || keywordNamesLower.length > 0) {
    const sortedKws = [...keywordIds, ...keywordNamesLower]
      .map(String)
      .map((item) => item.toLowerCase())
      .sort()
      .join(',');

    filterParts.push(`keywords:${sortedKws}`);
  }

  const dynamicCacheKey = filterParts.length > 0
    ? `${CACHE_KEY}:filters:${filterParts.join('|')}`
    : CACHE_KEY;

  // 2. Read Redis cache trước
  try {
    const cachedData = await redisGet(dynamicCacheKey);

    if (cachedData) {
      console.log(`[Redis] Frontier topics cache hit: ${dynamicCacheKey}`);
      return JSON.parse(cachedData);
    }

    console.log(`[Redis] Frontier topics cache miss: ${dynamicCacheKey}`);
  } catch (err) {
    console.warn(
      'Failed to get frontier topics from Redis cache, querying Neo4j:',
      err?.message || err
    );
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
    const cypher = `
      MATCH (t:Topic)<-[:HAS_TOPIC]-(a:Article)
      WHERE coalesce(a.is_deleted, false) = false
        AND ($subjectArea = "" OR toLower(t.name) = toLower($subjectArea))
        AND (size($topicNames) = 0 OR t.name IN $topicNames)
      WITH t, collect(a) AS articles
      UNWIND articles AS a
      OPTIONAL MATCH (citing:Article)-[:REFERENCES]->(a)
      WHERE coalesce(citing.is_deleted, false) = false
      WITH t, count(DISTINCT a) AS articleCount, count(citing) AS citationCount
      WHERE articleCount > 0
      RETURN t.name AS topic,
             toFloat(citationCount) / articleCount AS rawIF,
             toFloat(citationCount) AS rawVelocity
      ORDER BY rawIF DESC
      LIMIT 10
    `;

    const result = await session.run(cypher, {
      subjectArea: subjectArea || '',
      topicNames: topicNames
    });

    const rawRecords = result.records.map(r => ({
      topic: r.get('topic'),
      rawIF: r.get('rawIF'),
      rawVelocity: r.get('rawVelocity')
    }));

    const maxIF = rawRecords.reduce((max, r) => Math.max(max, r.rawIF), 0) || 1.0;
    const scaleIF = 10.0 / maxIF;

    const nonZeroVelocities = rawRecords
      .map(r => r.rawVelocity)
      .filter(v => v > 0)
      .sort((a, b) => a - b);

    const processed = rawRecords.map(record => {
      let impactFactor = record.rawIF * scaleIF;
      if (impactFactor < 0) impactFactor = 0;

      let citationVelocity = 0;

      if (record.rawVelocity > 0) {
        const index = nonZeroVelocities.indexOf(record.rawVelocity);
        const rank = nonZeroVelocities.length > 1
          ? index / (nonZeroVelocities.length - 1)
          : 1.0;

        citationVelocity = 3.0 + rank * 6.5;
      }

      if (citationVelocity < 0) citationVelocity = 0;

      impactFactor = Math.round(impactFactor * 10) / 10;
      citationVelocity = Math.round(citationVelocity * 10) / 10;

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

    // 3. Save Redis cache sau khi xử lý xong
    try {
      await redisSet(dynamicCacheKey, JSON.stringify(processed), CACHE_TTL);
      console.log(`[Redis] Frontier topics cached: ${dynamicCacheKey}`);
    } catch (err) {
      console.warn(
        'Failed to set frontier topics in Redis cache:',
        err?.message || err
      );
    }

    return processed;
  } finally {
    await session.close();
  }
}
