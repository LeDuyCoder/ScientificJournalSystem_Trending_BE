import { neo4jDriver } from '../../config/neo4j.js';
import { fetchWithCache } from './cache.service.js';
import logger from '../../utils/logger.js';

const CITATION_TTL = 900; // 15 mins

export async function getCitationMirroringData(scope, timeframeQuery) {
  const cacheKey = `analytics:citations:v3:${scope.resolvedProjectId || 'all'}:${scope.mappedDomain}:${scope.topicNames.join(',')}:${timeframeQuery.from_year}:${timeframeQuery.to_year}`;
  
  return fetchWithCache(cacheKey, CITATION_TTL, async () => {
    const { from_year, to_year } = timeframeQuery;
    const mirroringMap = {};
    for (let y = from_year; y <= to_year; y++) {
      mirroringMap[y] = { year: y, external: 0, self: 0 };
    }

    let neo4jSession = null;
    try {
      if (!neo4jDriver || !neo4jDriver.session) {
        throw new Error('Neo4j driver is not configured');
      }
      neo4jSession = neo4jDriver.session({ defaultAccessMode: 'READ' });

      let cypher = `
        MATCH (a:Article)
        WHERE coalesce(a.is_deleted, false) = false
          AND a.publication_year IS NOT NULL
          AND toInteger(a.publication_year) >= $fromYear
          AND toInteger(a.publication_year) <= $toYear
      `;

      if (scope.mappedDomain && scope.mappedDomain !== 'all') {
        cypher += `
          AND EXISTS {
            MATCH (a)-[:HAS_TOPIC]->(t:Topic)
            WHERE t.name IN $topicNames
          }
        `;
      }

      cypher += `
        MATCH (a)-[r:REFERENCES]->(b:Article)
        WHERE coalesce(b.is_deleted, false) = false
        WITH a, b, EXISTS { (a)<-[:WRITES]-(:Author)-[:WRITES]->(b) } AS isSelf
        RETURN toInteger(a.publication_year) AS year,
               sum(CASE WHEN isSelf THEN 1 ELSE 0 END) AS self,
               sum(CASE WHEN NOT isSelf THEN 1 ELSE 0 END) AS external
      `;

      const cypherParams = {
        fromYear: from_year,
        toYear: to_year,
        topicNames: scope.topicNames || []
      };

      const result = await neo4jSession.run(cypher, cypherParams);
      result.records.forEach(record => {
        const year = record.get('year').toNumber();
        if (mirroringMap[year]) {
          mirroringMap[year].self = record.get('self').toNumber();
          mirroringMap[year].external = record.get('external').toNumber();
        }
      });
    } catch (err) {
      logger.error('Error fetching citation mirroring data from Neo4j:', err);
    } finally {
      if (neo4jSession) await neo4jSession.close();
    }

    return { data: Object.values(mirroringMap) };
  });
}
