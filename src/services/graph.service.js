import { neo4jDriver } from '../config/neo4j.js';

export async function searchArticlesByKeyword(keyword, options = {}) {
  const driver = neo4jDriver;

  if (!driver) {
    throw new Error(
      'Neo4j driver is not configured. Please set NEO4J_URI/NEO4J_USER/NEO4J_PASSWORD.'
    );
  }

  // Decode keyword để tránh bị dính machine%20learning
  function decodeKeyword(value) {
    if (Array.isArray(value)) {
      value = value[0] ?? '';
    }

    let text = String(value ?? '').replace(/\+/g, ' ').trim();

    // Decode tối đa 2 lần để xử lý cả case bị encode double: %2520 -> %20 -> space
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

  const rawLimit = Number(options.limit);

  const limit =
    Number.isInteger(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, 500)
      : 50;

  const searchKeyword = decodeKeyword(keyword);

  const cypher = `
    MATCH (n:Article)
    WHERE $keyword = ''
       OR toLower(coalesce(n.title, '')) CONTAINS toLower($keyword)

    WITH n
    LIMIT toInteger($limit)

    OPTIONAL MATCH (n)-[r]-(m)

    RETURN n, r, m
  `;

  const session = driver.session({ defaultAccessMode: 'READ' });

  try {
    const result = await session.run(cypher, {
      keyword: searchKeyword,
      limit,
    });

    const nodeMap = new Map();
    const relMap = new Map();

    for (const record of result.records) {
      const n = record.get('n');
      const m = record.get('m');
      const r = record.get('r');

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

    return {
      source: 'neo4j',
      keyword: searchKeyword,
      nodes: Array.from(nodeMap.values()),
      relationships: Array.from(relMap.values()),
    };
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