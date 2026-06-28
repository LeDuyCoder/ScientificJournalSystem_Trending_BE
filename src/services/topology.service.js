import pool from '../config/database.js';
import { neo4jDriver } from '../config/neo4j.js';
import { redisGet, redisSet } from './redis.service.js';
import logger from '../../utils/logger.js';

const CACHE_TTL = 600;

function prepareKeywords(keywords) {
  if (!keywords) return [];
  const list = Array.isArray(keywords) ? keywords : String(keywords).split(',');
  return list.map(k => String(k).trim()).filter(Boolean);
}

export async function getNetworkTopology(options = {}) {
  const { project_id, network_type = 'all', subject_area, keywords, from_year, to_year, limit_nodes = 50, min_weight = 0.1 } = options;

  if (!project_id || project_id === 'undefined' || project_id === 'null') {
    const error = new Error('project_id is required');
    error.status = 400;
    throw error;
  }

  const limitNodes = Number(limit_nodes) > 0 ? Number(limit_nodes) : 50;
  const minWeight = Number(min_weight) >= 0 ? Number(min_weight) : 0.1;
  const keywordList = prepareKeywords(keywords);
  const normalizedKeywords = [...keywordList].map(s => s.toLowerCase()).sort().join(',');

  const cacheKey = `analytics:network:topology:v1:${project_id}:${network_type}:${(subject_area || '').toLowerCase()}:${normalizedKeywords}:${from_year || ''}:${to_year || ''}:${limitNodes}:${minWeight}`;

  try {
    const cachedData = await redisGet(cacheKey);
    if (cachedData) return JSON.parse(cachedData);
  } catch (err) {
    logger.warn('Failed to get topology data from Redis:', err?.message);
  }

  const client = await pool.connect();
  let filterTopicIds = [];
  let filterKeywordIds = [];
  let projectTopicIds = [];
  let projectKwIds = [];

  try {
    const projectRes = await client.query(
      `SELECT project_id, subject_area FROM "Project" WHERE project_id = $1`,
      [project_id]
    );

    if (projectRes.rows.length === 0) {
      const error = new Error('Project not found');
      error.status = 404;
      throw error;
    }

    const project = projectRes.rows[0];

    const projectCatRes = await client.query(
      `SELECT subject_category_id FROM "Subject_Category" WHERE subject_area_id = $1 AND COALESCE(is_deleted, false) = false`,
      [project.subject_area]
    );
    const projectCatIds = projectCatRes.rows.map(r => Number(r.subject_category_id));

    const projectKwRes = await client.query(
      `SELECT keyword_id FROM "Project_Keyword" WHERE project_id = $1`,
      [project_id]
    );
    projectKwIds = projectKwRes.rows.map(r => Number(r.keyword_id));

    if (projectCatIds.length > 0) {
      const pTopicRes = await client.query(
        `SELECT topic_id FROM "Topic" WHERE subject_category_id = ANY($1::bigint[])`,
        [projectCatIds]
      );
      projectTopicIds = pTopicRes.rows.map(r => Number(r.topic_id));
    }

    if (projectTopicIds.length === 0 && projectKwIds.length === 0) {
      return { nodes: [], edges: [] };
    }

    if (subject_area) {
      const saRes = await client.query(
        `SELECT subject_area_id FROM "Subject_Area" WHERE LOWER(display_name) = LOWER($1) AND COALESCE(is_deleted, false) = false`,
        [subject_area.trim()]
      );
      if (saRes.rows.length > 0) {
        const saId = saRes.rows[0].subject_area_id;
        const scRes = await client.query(
          `SELECT subject_category_id FROM "Subject_Category" WHERE subject_area_id = $1 AND COALESCE(is_deleted, false) = false`,
          [saId]
        );
        const catIds = scRes.rows.map(r => Number(r.subject_category_id));
        if (catIds.length > 0) {
          const topicRes = await client.query(
            `SELECT topic_id FROM "Topic" WHERE subject_category_id = ANY($1::bigint[])`,
            [catIds]
          );
          filterTopicIds = topicRes.rows.map(r => Number(r.topic_id));
        }
      }
      
      if (filterTopicIds.length === 0) {
        return { nodes: [], edges: [] };
      }
    }

    if (keywordList.length > 0) {
      const kwRes = await client.query(
        `SELECT keyword_id FROM "Keyword" WHERE LOWER(display_name) = ANY($1::text[])`,
        [keywordList.map(s => s.toLowerCase())]
      );
      filterKeywordIds = kwRes.rows.map(r => Number(r.keyword_id));
      
      if (filterKeywordIds.length === 0) {
         return { nodes: [], edges: [] };
      }
    }

  } finally {
    client.release();
  }

  const session = neo4jDriver.session();
  try {
    const fromYearInt = from_year ? Number(from_year) : null;
    const toYearInt = to_year ? Number(to_year) : null;

    const baseMatch = `
      MATCH (a:Article)
      WHERE ($fromYear IS NULL OR a.publication_year >= $fromYear)
        AND ($toYear IS NULL OR a.publication_year <= $toYear)
        AND (
          (size($pTopicIds) > 0 AND EXISTS { MATCH (a)-[:HAS_TOPIC]->(t:Topic) WHERE toInteger(t.id) IN $pTopicIds })
          OR 
          (size($pKwIds) > 0 AND EXISTS { MATCH (a)-[:HAS_KEYWORD]->(k:Keyword) WHERE toInteger(k.id) IN $pKwIds })
        )
        AND (size($fTopicIds) = 0 OR EXISTS { MATCH (a)-[:HAS_TOPIC]->(t2:Topic) WHERE toInteger(t2.id) IN $fTopicIds })
        AND (size($fKwIds) = 0 OR EXISTS { MATCH (a)-[:HAS_KEYWORD]->(k2:Keyword) WHERE toInteger(k2.id) IN $fKwIds })
    `;

    const params = {
      fromYear: fromYearInt,
      toYear: toYearInt,
      pTopicIds: projectTopicIds,
      pKwIds: projectKwIds,
      fTopicIds: filterTopicIds,
      fKwIds: filterKeywordIds
    };

    let allNodes = [];
    let allEdges = [];

    const fetchConceptual = network_type === 'conceptual' || network_type === 'all';
    const fetchCollaboration = network_type === 'collaboration' || network_type === 'all';

    if (fetchConceptual) {
      const conceptNodesQuery = `
        ${baseMatch}
        MATCH (a)-[:HAS_KEYWORD]->(k:Keyword)
        RETURN k.id AS id, k.name AS label, 'KEYWORD' AS type, count(a) AS size
      `;
      const conceptEdgesQuery = `
        ${baseMatch}
        MATCH (k1:Keyword)<-[:HAS_KEYWORD]-(a)-[:HAS_KEYWORD]->(k2:Keyword)
        WHERE id(k1) < id(k2)
        RETURN k1.id AS from, k2.id AS to, 'CONCEPTUAL_PROXIMITY' AS type, count(a) AS weight
      `;

      const nRes = await session.run(conceptNodesQuery, params);
      const eRes = await session.run(conceptEdgesQuery, params);

      nRes.records.forEach(r => {
        allNodes.push({
          id: `kw_${r.get('id')}`,
          label: r.get('label') || 'Unknown',
          type: r.get('type'),
          size: r.get('size').toNumber ? r.get('size').toNumber() : Number(r.get('size'))
        });
      });

      eRes.records.forEach(r => {
        allEdges.push({
          from: `kw_${r.get('from')}`,
          to: `kw_${r.get('to')}`,
          type: r.get('type'),
          weight: r.get('weight').toNumber ? r.get('weight').toNumber() : Number(r.get('weight'))
        });
      });
    }

    if (fetchCollaboration) {
      const collabNodesQuery = `
        ${baseMatch}
        MATCH (auth:Author)-[:WRITES]->(a)
        RETURN auth.id AS id, auth.name AS label, 'AUTHOR' AS type, count(a) AS size
      `;
      const collabEdgesQuery = `
        ${baseMatch}
        MATCH (auth1:Author)-[:WRITES]->(a)<-[:WRITES]-(auth2:Author)
        WHERE id(auth1) < id(auth2)
        RETURN auth1.id AS from, auth2.id AS to, 'CO_AUTHORSHIP' AS type, count(a) AS weight
      `;

      const nRes = await session.run(collabNodesQuery, params);
      const eRes = await session.run(collabEdgesQuery, params);

      nRes.records.forEach(r => {
        allNodes.push({
          id: `auth_${r.get('id')}`,
          label: r.get('label') || 'Unknown',
          type: r.get('type'),
          size: r.get('size').toNumber ? r.get('size').toNumber() : Number(r.get('size'))
        });
      });

      eRes.records.forEach(r => {
        allEdges.push({
          from: `auth_${r.get('from')}`,
          to: `auth_${r.get('to')}`,
          type: r.get('type'),
          weight: r.get('weight').toNumber ? r.get('weight').toNumber() : Number(r.get('weight'))
        });
      });
    }

    // Processing & Normalization
    if (allNodes.length === 0) {
      return { nodes: [], edges: [] };
    }

    // 1. Sort nodes by size DESC and apply limit_nodes
    allNodes.sort((a, b) => b.size - a.size);
    const topNodes = allNodes.slice(0, limitNodes);
    
    // Create a Set for fast lookup of allowed nodes
    const allowedNodeIds = new Set(topNodes.map(n => n.id));

    // 2. Filter edges (both ends must exist in topNodes)
    let validEdges = allEdges.filter(e => allowedNodeIds.has(e.from) && allowedNodeIds.has(e.to));

    // 3. Normalize node sizes (10 to 40)
    let maxSize = 0;
    let minSize = Infinity;
    topNodes.forEach(n => {
      if (n.size > maxSize) maxSize = n.size;
      if (n.size < minSize) minSize = n.size;
    });

    topNodes.forEach(n => {
      if (maxSize === minSize) {
        n.size = 20; // Default size if all nodes have the same frequency
      } else {
        // Linear interpolation mapping [minSize, maxSize] to [10, 40]
        n.size = 10 + ((n.size - minSize) / (maxSize - minSize)) * 30;
      }
      n.size = Math.round(n.size * 100) / 100;
    });

    // 4. Normalize edge weights (0 to 1) and apply min_weight
    let maxWeight = 0;
    validEdges.forEach(e => {
      if (e.weight > maxWeight) maxWeight = e.weight;
    });

    let finalEdges = [];
    validEdges.forEach(e => {
      let normWeight = 0;
      if (maxWeight > 0) {
        normWeight = e.weight / maxWeight;
      }
      normWeight = Math.round(normWeight * 100) / 100;

      if (normWeight >= minWeight) {
        finalEdges.push({
          from: e.from,
          to: e.to,
          type: e.type,
          weight: normWeight,
          label: `${normWeight}`
        });
      }
    });

    finalEdges.sort((a, b) => b.weight - a.weight);

    const result = {
      nodes: topNodes,
      edges: finalEdges
    };

    try {
      await redisSet(cacheKey, JSON.stringify(result), CACHE_TTL);
    } catch (err) {
      logger.warn('Failed to cache topology data:', err?.message);
    }

    return result;

  } finally {
    await session.close();
  }
}
