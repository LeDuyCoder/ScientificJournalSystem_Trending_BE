import { neo4jDriver } from '../config/neo4j.js';

/**
 * Run a Cypher query against Neo4j.
 *
 * @param {string} cypher - Cypher query.
 * @param {Record<string, any>} [params] - Query parameters.
 * @returns {Promise<import('neo4j-driver').ResultSummary>} Result summary.
 */
export async function runNeo4jQuery(cypher, params = {}) {
  const session = neo4jDriver.session({ defaultAccessMode: 'WRITE' });
  try {
    const result = await session.run(cypher, params);
    return result;
  } finally {
    await session.close();
  }
}


