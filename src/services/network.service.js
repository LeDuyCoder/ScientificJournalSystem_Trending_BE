import pool from '../config/database.js';
import { neo4jDriver } from '../config/neo4j.js';
import { redisGet, redisSet } from './redis.service.js';
import logger from '../../utils/logger.js';

const CACHE_TTL = 600; // 10 minutes cho Graph Data

function prepareKeywords(keywords) {
  if (!keywords) return [];
  const list = Array.isArray(keywords) ? keywords : String(keywords).split(',');
  return list.map(k => String(k).trim()).filter(Boolean);
}

export async function getCollaborationNetwork(options = {}) {
  const { project_id, subject_area, keywords, from_year, to_year, limit_nodes = 50, min_weight = 1 } = options;

  if (!project_id || project_id === 'undefined' || project_id === 'null') {
    const error = new Error('project_id is required for Global Collaboration Network');
    error.status = 400;
    throw error;
  }

  const limitNodes = Number(limit_nodes) > 0 ? Number(limit_nodes) : 50;
  const minWeight = Number(min_weight) > 0 ? Number(min_weight) : 1;
  const keywordList = prepareKeywords(keywords);
  const normalizedKeywords = [...keywordList].map(s => s.toLowerCase()).sort().join(',');

  const cacheKey = `analytics:network:collab:v1:${project_id}:${(subject_area || '').toLowerCase()}:${normalizedKeywords}:${from_year || ''}:${to_year || ''}:${limitNodes}:${minWeight}`;

  try {
    const cachedData = await redisGet(cacheKey);
    if (cachedData) return JSON.parse(cachedData);
  } catch (err) {
    logger.warn('Failed to get network data from Redis:', err?.message);
  }

  const client = await pool.connect();
  let filterTopicIds = [];
  let filterKeywordIds = [];
  let projectTopicIds = [];
  let projectKwIds = [];

  try {
    // 1. Get Project
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

    // Get Project tracking scopes
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

    // Convert projectCatIds to projectTopicIds
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

    // Apply Intersection Custom Filters
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

  // 2. Query Neo4j
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

    const authorNodesQuery = `
      ${baseMatch}
      MATCH (auth:Author)-[:WRITES]->(a)
      RETURN auth.id AS id, auth.name AS label, 'AUTHOR' AS type, count(a) AS article_count
    `;

    const instNodesQuery = `
      ${baseMatch}
      MATCH (auth:Author)-[:WRITES]->(a)
      MATCH (auth)-[:AFFILIATED_WITH]->(inst:Institution)
      RETURN inst.id AS id, inst.name AS label, 'INSTITUTION' AS type, count(DISTINCT auth) AS author_count
    `;

    const authorEdgesQuery = `
      ${baseMatch}
      MATCH (auth1:Author)-[:WRITES]->(a)<-[:WRITES]-(auth2:Author)
      WHERE auth1.id < auth2.id
      RETURN auth1.id AS from, auth2.id AS to, count(a) AS weight
    `;

    const instEdgesQuery = `
      ${baseMatch}
      MATCH (auth:Author)-[:WRITES]->(a)
      MATCH (auth)-[:AFFILIATED_WITH]->(inst:Institution)
      RETURN auth.id AS from, inst.id AS to, count(a) AS weight
    `;

    const params = {
      pTopicIds: projectTopicIds,
      pKwIds: projectKwIds,
      fTopicIds: filterTopicIds,
      fKwIds: filterKeywordIds,
      fromYear: fromYearInt,
      toYear: toYearInt
    };

    const authNodesRes = await session.run(authorNodesQuery, params);
    const instNodesRes = await session.run(instNodesQuery, params);
    const authEdgesRes = await session.run(authorEdgesQuery, params);
    const instEdgesRes = await session.run(instEdgesQuery, params);

    const nodes = [];
    const edgesMap = new Map();

    authNodesRes.records.forEach(r => {
      const articleCount = r.get('article_count').toNumber();
      nodes.push({
        id: `auth_${r.get('id')}`,
        label: r.get('label') || 'Unknown Author',
        type: 'AUTHOR',
        size: 12 + Math.min(articleCount * 2, 20),
        color: '#FF6B00',
        score: articleCount
      });
    });

    instNodesRes.records.forEach(r => {
      const authorCount = r.get('author_count').toNumber();
      nodes.push({
        id: `inst_${r.get('id')}`,
        label: r.get('label') || 'Unknown Institution',
        type: 'INSTITUTION',
        size: 12 + Math.min(authorCount * 2, 20),
        color: '#1A202C',
        score: authorCount
      });
    });

    // Sort nodes and limit
    nodes.sort((a, b) => b.score - a.score);
    const finalNodes = nodes.slice(0, limitNodes);
    
    // Cleanup score field for response
    finalNodes.forEach(n => delete n.score);

    // Set of valid node ids
    const validNodeIds = new Set(finalNodes.map(n => n.id));

    const addEdge = (from, to, weight, labelSuffix) => {
      if (validNodeIds.has(from) && validNodeIds.has(to) && weight >= minWeight) {
        const key = `${from}-${to}`;
        if (edgesMap.has(key)) {
          edgesMap.get(key).weight += weight;
        } else {
          edgesMap.set(key, { from, to, weight, label: `${weight} ${labelSuffix}` });
        }
      }
    };

    authEdgesRes.records.forEach(r => {
      addEdge(`auth_${r.get('from')}`, `auth_${r.get('to')}`, r.get('weight').toNumber(), 'joint ventures');
    });

    instEdgesRes.records.forEach(r => {
      addEdge(`auth_${r.get('from')}`, `inst_${r.get('to')}`, r.get('weight').toNumber(), 'affiliations');
    });

    const finalEdges = Array.from(edgesMap.values());
    finalEdges.sort((a, b) => b.weight - a.weight);

    const result = {
      nodes: finalNodes,
      edges: finalEdges
    };

    try {
      await redisSet(cacheKey, JSON.stringify(result), CACHE_TTL);
    } catch (e) {
      logger.warn('Failed to set network data to Redis:', e?.message);
    }

    return result;
  } finally {
    await session.close();
  }
}
