import { neo4jDriver } from '../../config/neo4j.js';
import { fetchWithCache } from './cache.service.js';
import logger from '../../utils/logger.js';

const FRONTIER_TTL = 3600; // 1 hour

export async function getFrontierDetectionData(scope) {
  const cacheKey = `analytics:frontier:v4:${scope.resolvedProjectId || 'all'}:${scope.mappedDomain}:${scope.topicNames.join(',')}`;
  
  return fetchWithCache(cacheKey, FRONTIER_TTL, async () => {
    let frontierDetectionItems = [];

    let neo4jSession = null;
    try {
      if (!neo4jDriver || !neo4jDriver.session) {
        throw new Error('Neo4j driver is not configured');
      }
      neo4jSession = neo4jDriver.session({ defaultAccessMode: 'READ' });

      // Optimized Cypher: Push aggregations to the Article node directly if citation_count is stored on the node
      // Avoiding traversing the [:REFERENCES] relationships entirely for purely counting citations.
      const cypher = `
        MATCH (a:Article)-[:HAS_TOPIC]->(t:Topic)
        WHERE coalesce(a.is_deleted, false) = false
          AND ($subjectArea = "" OR toLower(t.name) = toLower($subjectArea))
          AND (size($topicNames) = 0 OR t.name IN $topicNames)
        WITH t, count(a) AS articleCount, sum(coalesce(a.citation_count, 0)) AS citationCount
        WHERE articleCount > 0
        RETURN t.name AS topic,
               toFloat(citationCount) / articleCount AS rawIF,
               toFloat(citationCount) AS rawVelocity
        ORDER BY rawIF DESC
        LIMIT 10
      `;

      const result = await neo4jSession.run(cypher, {
        subjectArea: scope.mappedDomain !== 'all' ? scope.mappedDomain : '',
        topicNames: scope.topicNames || []
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

      frontierDetectionItems = rawRecords.map(record => {
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

        let status = 'emerging';
        if (impactFactor >= 3.0 && citationVelocity >= 5.0) {
          status = 'frontier';
        }

        return {
          label: record.topic,
          impactVelocity: impactFactor,
          citationVelocity: citationVelocity,
          status: status
        };
      });
    } catch (err) {
      logger.error('Error fetching frontier topics:', err);
    } finally {
      if (neo4jSession) await neo4jSession.close();
    }

    return { items: frontierDetectionItems };
  });
}
