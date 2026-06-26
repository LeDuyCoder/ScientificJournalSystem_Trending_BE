import { neo4jDriver } from '../config/neo4j.js';

export async function searchArticlesByKeyword(keyword, options = {}) {
  const driver = neo4jDriver;

  if (!driver) {
    throw new Error(
      'Neo4j driver is not configured. Please set NEO4J_URI/NEO4J_USER/NEO4J_PASSWORD.'
    );
  }

  const limit = Number.isFinite(Number(options.limit))
    ? Number(options.limit)
    : 50;

  const searchKeyword = String(keyword || '').trim();

  const cypher = `
    MATCH (a:Article)
    WHERE
      $keyword = ''
      OR toLower(coalesce(a.title, '')) CONTAINS toLower($keyword)
      OR toLower(coalesce(a.doi, '')) CONTAINS toLower($keyword)
      OR toLower(toString(coalesce(a.publication_year, ''))) CONTAINS toLower($keyword)
      OR toLower(toString(coalesce(a.id, ''))) CONTAINS toLower($keyword)

    WITH a
    LIMIT toInteger($limit)

    MATCH (a)-[r:REFERENCES]-(b:Article)

    RETURN a, r, b
  `;

  const session = driver.session({ defaultAccessMode: 'READ' });

  try {
    const result = await session.run(cypher, {
      keyword: searchKeyword,
      limit,
    });

    const nodeMap = new Map();
    const relMap = new Map();

    for (const row of result.records) {
      const a = row.get('a');
      const b = row.get('b');
      const r = row.get('r');

      if (a) {
        const id = a.identity.toString();

        if (!nodeMap.has(id)) {
          nodeMap.set(id, {
            id,
            labels: Array.from(a.labels || []),
            properties: normalizeNeo4jProperties(a.properties || {}),
          });
        }
      }

      if (b) {
        const id = b.identity.toString();

        if (!nodeMap.has(id)) {
          nodeMap.set(id, {
            id,
            labels: Array.from(b.labels || []),
            properties: normalizeNeo4jProperties(b.properties || {}),
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