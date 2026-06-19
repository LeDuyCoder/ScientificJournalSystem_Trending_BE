import neo4j from 'neo4j-driver';
import { getEnvOptional } from './env.js';

let _neo4jDriver;

function getNeo4jDriver() {
  // Resolve at call-time để tránh vấn đề env thay đổi / server chạy instance khác.
  const NEO4J_URI = getEnvOptional('NEO4J_URI');
  const NEO4J_USER = getEnvOptional('NEO4J_USER');
  const NEO4J_PASSWORD = getEnvOptional('NEO4J_PASSWORD');
  const NEO4J_MAX_CONNECTIONS = process.env.NEO4J_MAX_CONNECTIONS
    ? Number(process.env.NEO4J_MAX_CONNECTIONS)
    : undefined;

  if (!NEO4J_URI || !NEO4J_USER || !NEO4J_PASSWORD) {
    return undefined;
  }

  if (_neo4jDriver) return _neo4jDriver;

  _neo4jDriver = neo4j.driver(
    NEO4J_URI,
    neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
    {
      maxConnectionPoolSize: NEO4J_MAX_CONNECTIONS,
    },
  );

  neo4jDriver = _neo4jDriver;
  return _neo4jDriver;
}

/**
 * Neo4j driver instance (lazy-created).
 *
 * Note: this value is exported for compatibility, but the project primarily
 * uses {@link checkNeo4j} which resolves the driver at call-time.
 */
export let neo4jDriver;


/**
 * Verify Neo4j connectivity by running a lightweight query.
 *
 * @returns {Promise<{ok: true}>}
 * @throws {Error} When Neo4j is not configured or query execution fails.
 */
export async function checkNeo4j() {
  const driver = getNeo4jDriver();
  if (!driver) {
    const missing = [
      !getEnvOptional('NEO4J_URI') ? 'NEO4J_URI' : null,
      !getEnvOptional('NEO4J_USER') ? 'NEO4J_USER' : null,
      !getEnvOptional('NEO4J_PASSWORD') ? 'NEO4J_PASSWORD' : null,
    ].filter(Boolean);

    throw new Error(`Neo4j không cấu hình đủ env vars: ${missing.join(', ') || 'unknown'}`);
  }


  const session = driver.session({ defaultAccessMode: 'READ' });
  try {
    const result = await session.run('RETURN 1 AS ok');
    const record = result.records[0];
    const ok = record?.get('ok');

    // neo4j-driver có thể trả về number/string tuỳ phiên bản & parser.
    const okNumber = typeof ok === 'number' ? ok : Number(ok);
    if (Number.isNaN(okNumber) || okNumber !== 1) {
      throw new Error(`Unexpected Neo4j response: ok=${ok}`);
    }

    return { ok: true };
  } finally {
    await session.close();
  }
}

/**
 * Close Neo4j driver if it was created.
 *
 * @returns {Promise<void>}
 */
export async function closeNeo4j() {
  if (_neo4jDriver) {
    await _neo4jDriver.close();
    _neo4jDriver = undefined;
  }
}



