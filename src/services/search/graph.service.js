import { neo4jDriver } from '../../config/neo4j.js';
import { redisGet, redisSet } from '../infrastructure/redis.service.js';
import logger from '../../utils/logger.js';

export async function searchArticlesByKeyword(keyword, options = {}) {
  const driver = neo4jDriver;

  if (!driver) {
    throw new Error(
      'Neo4j driver is not configured. Please set NEO4J_URI/NEO4J_USER/NEO4J_PASSWORD.'
    );
  }

  function decodeKeyword(value) {
    if (Array.isArray(value)) {
      value = value[0] ?? '';
    }

    let text = String(value ?? '').replace(/\+/g, ' ').trim();

    for (let i = 0; i < 2; i++) {
      try {
        const decoded = decodeURIComponent(text);
        if (decoded === text) break;
        text = decoded;
      } catch {
        break;
      }
    }

    return text.trim();
  }

  function prepareLuceneKeyword(val) {
    const decoded = decodeKeyword(val);
    return decoded
      .replace(/([\+\-\!\(\)\{\}\[\]\^\'\`\"\~\*\?\:\\\/])/g, '\\$1')
      .replace(/\&\&/g, '\\&\\&')
      .replace(/\|\|/g, '\\|\\|')
      .trim();
  }

  const rawLimit = Number(options.limit);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 50;
  const searchKeyword = decodeKeyword(keyword);
  const luceneKeyword = prepareLuceneKeyword(keyword);

  if (!luceneKeyword) {
    return {
      source: 'neo4j',
      keyword: searchKeyword,
      nodes: [],
      relationships: [],
    };
  }

  const cacheKey = `search:articles:kw:${searchKeyword.toLowerCase()}:limit:${limit}`;

  try {
    const cached = await redisGet(cacheKey);
    if (cached) {
      logger.info(`[Redis] Search graph cache hit for key: ${cacheKey}`);
      const data = JSON.parse(cached);
      data.source = 'redis';
      return data;
    }
  } catch (err) {
    logger.warn('Failed to retrieve search graph from Redis, fallback to DB:', err?.message || err);
  }

  const cypher = `
    CALL db.index.fulltext.queryNodes('article_title_ft', $keyword)
    YIELD node, score
    WITH node, score
    ORDER BY score DESC
    LIMIT toInteger($limit)
    CALL {
      WITH node
      OPTIONAL MATCH (node)-[r]-(m)
      WITH r, m
      LIMIT 30
      RETURN collect({ r: r, m: m }) AS rels
    }
    RETURN node, rels
  `;

  const startTime = Date.now();
  const session = driver.session({ defaultAccessMode: 'READ' });

  try {
    const result = await session.run(cypher, {
      keyword: luceneKeyword,
      limit,
    });

    const queryDuration = Date.now() - startTime;
    logger.info(`[Neo4j] Cypher query completed in ${queryDuration}ms for keyword "${searchKeyword}"`);

    const nodeMap = new Map();
    const relMap = new Map();

    const records = result.records;
    const len = records.length;

    for (let i = 0; i < len; i++) {
      const record = records[i];
      const n = record.get('node');
      const rels = record.get('rels') || [];

      if (n) {
        const id = n.identity.toString();
        if (!nodeMap.has(id)) {
          nodeMap.set(id, {
            id,
            labels: Array.from(n.labels || []),
            properties: normalizeNeo4jProperties(n.properties || {}),
          });
        }
      }

      const relsLen = rels.length;
      for (let j = 0; j < relsLen; j++) {
        const relObj = rels[j];
        const r = relObj.r;
        const m = relObj.m;

        if (m) {
          const id = m.identity.toString();
          if (!nodeMap.has(id)) {
            nodeMap.set(id, {
              id,
              labels: Array.from(m.labels || []),
              properties: normalizeNeo4jProperties(m.properties || {}),
            });
          }
        }

        if (r) {
          const relId = r.identity.toString();
          if (!relMap.has(relId)) {
            relMap.set(relId, {
              id: relId,
              type: r.type,
              start: r.start.toString(),
              end: r.end.toString(),
              properties: normalizeNeo4jProperties(r.properties || {}),
            });
          }
        }
      }
    }

    const payload = {
      source: 'neo4j',
      keyword: searchKeyword,
      nodes: Array.from(nodeMap.values()),
      relationships: Array.from(relMap.values()),
    };

    try {
      await redisSet(cacheKey, JSON.stringify(payload), 43200);
      logger.info(`[Redis] Search graph results cached for key: ${cacheKey}`);
    } catch (cacheErr) {
      logger.warn('Failed to save search graph to Redis:', cacheErr?.message || cacheErr);
    }

    return payload;
  } finally {
    await session.close();
  }
}

function normalizeNeo4jProperties(properties) {
  const normalized = {};
  for (const [key, value] of Object.entries(properties)) {
    normalized[key] = normalizeNeo4jValue(value);
  }
  return normalized;
}

function normalizeNeo4jValue(value) {
  if (value && typeof value.toNumber === 'function') {
    return value.toNumber();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeNeo4jValue);
  }
  if (value && typeof value === 'object') {
    const obj = {};
    for (const [key, val] of Object.entries(value)) {
      obj[key] = normalizeNeo4jValue(val);
    }
    return obj;
  }
  return value;
}