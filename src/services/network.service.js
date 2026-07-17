import pool from '../config/database.js';
import { redisGet, redisSet } from './redis.service.js';
import logger from '../utils/logger.js';

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

  const cacheKey = `analytics:network:collab:v4:${project_id}:${(subject_area || '').toLowerCase()}:${normalizedKeywords}:${from_year || ''}:${to_year || ''}:${limitNodes}:${minWeight}`;

  try {
    const cachedData = await redisGet(cacheKey);
    if (cachedData) return JSON.parse(cachedData);
  } catch (err) {
    logger.warn('Failed to get network data from Redis:', err?.message);
  }

  const client = await pool.connect();
  
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
    const projectKwIds = projectKwRes.rows.map(r => Number(r.keyword_id));

    let projectTopicIds = [];
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
    let filterTopicIds = [];
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

    let filterKeywordIds = [];
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

    // 2. Build Article Filter CTE
    const cteParts = [];
    const params = [];

    // Project Scope topics / keywords
    if (projectTopicIds.length > 0 || projectKwIds.length > 0) {
      const scopeSelects = [];
      if (projectTopicIds.length > 0) {
        params.push(projectTopicIds);
        const pTopicIdx = params.length;
        scopeSelects.push(`
          SELECT a.article_id
          FROM "Article" a
          WHERE a.primary_topic = ANY($${pTopicIdx}::bigint[]) AND COALESCE(a.is_deleted, false) = false
          UNION
          SELECT st.article_id
          FROM "Sub_Topic" st
          WHERE st.topic_id = ANY($${pTopicIdx}::bigint[])
        `);
      }
      if (projectKwIds.length > 0) {
        params.push(projectKwIds);
        const pKwIdx = params.length;
        scopeSelects.push(`
          SELECT article_id
          FROM "Keyword_Article"
          WHERE keyword_id = ANY($${pKwIdx}::bigint[])
        `);
      }
      cteParts.push(`project_articles AS (${scopeSelects.join(' UNION ')})`);
    }

    // Custom Subject Area Filter
    if (filterTopicIds.length > 0) {
      params.push(filterTopicIds);
      const fTopicIdx = params.length;
      cteParts.push(`filter_sa_articles AS (
        SELECT a.article_id
        FROM "Article" a
        WHERE a.primary_topic = ANY($${fTopicIdx}::bigint[]) AND COALESCE(a.is_deleted, false) = false
        UNION
        SELECT st.article_id
        FROM "Sub_Topic" st
        WHERE st.topic_id = ANY($${fTopicIdx}::bigint[])
      )`);
    }

    // Custom Keyword Filter
    if (filterKeywordIds.length > 0) {
      params.push(filterKeywordIds);
      const fKwIdx = params.length;
      cteParts.push(`filter_kw_articles AS (
        SELECT article_id
        FROM "Keyword_Article"
        WHERE keyword_id = ANY($${fKwIdx}::bigint[])
      )`);
    }

    // Year range filters
    const yearFilters = [];
    if (from_year) {
      params.push(Number(from_year));
      yearFilters.push(`a.publication_year >= $${params.length}`);
    }
    if (to_year) {
      params.push(Number(to_year));
      yearFilters.push(`a.publication_year <= $${params.length}`);
    }
    const yearSql = yearFilters.length > 0 ? `AND ${yearFilters.join(' AND ')}` : '';

    // Join them all to form `filtered_articles`
    const joins = [];
    if (projectTopicIds.length > 0 || projectKwIds.length > 0) {
      joins.push(`JOIN project_articles pa ON a.article_id = pa.article_id`);
    }
    if (filterTopicIds.length > 0) {
      joins.push(`JOIN filter_sa_articles fsa ON a.article_id = fsa.article_id`);
    }
    if (filterKeywordIds.length > 0) {
      joins.push(`JOIN filter_kw_articles fkw ON a.article_id = fkw.article_id`);
    }

    cteParts.push(`filtered_articles AS (
      SELECT a.article_id, a.publication_year
      FROM "Article" a
      ${joins.join('\n      ')}
      WHERE COALESCE(a.is_deleted, false) = false
        ${yearSql}
    )`);

    const cteSql = `WITH ${cteParts.join(',\n')}`;

    // Query 1: Author Nodes
    const authorNodesQuery = `
      ${cteSql}
      SELECT 
        au.author_id AS id, 
        au.display_name AS label, 
        'AUTHOR' AS type, 
        COUNT(DISTINCT a.article_id)::integer AS article_count
      FROM "Author" au
      JOIN "Author_Article" aa ON au.author_id = aa.author_id
      JOIN filtered_articles a ON aa.article_id = a.article_id
      WHERE COALESCE(au.is_deleted, false) = false
      GROUP BY au.author_id, au.display_name
    `;

    // Query 2: Institution Nodes
    const instNodesQuery = `
      ${cteSql}
      SELECT 
        inst.institution_id AS id, 
        inst.display_name AS label, 
        'INSTITUTION' AS type, 
        COUNT(DISTINCT au.author_id)::integer AS author_count
      FROM "Institution" inst
      JOIN "Institution_Author" ia ON inst.institution_id = ia.institution_id
      JOIN "Author" au ON ia.author_id = au.author_id
      JOIN "Author_Article" aa ON au.author_id = aa.author_id
      JOIN filtered_articles a ON aa.article_id = a.article_id AND ia.year = a.publication_year
      WHERE COALESCE(inst.is_deleted, false) = false
        AND COALESCE(au.is_deleted, false) = false
      GROUP BY inst.institution_id, inst.display_name
    `;

    // Query 3: Author Edges (joint ventures)
    const authorEdgesQuery = `
      ${cteSql}
      SELECT 
        aa1.author_id AS from_id, 
        aa2.author_id AS to_id, 
        COUNT(DISTINCT a.article_id)::integer AS weight
      FROM filtered_articles a
      JOIN "Author_Article" aa1 ON a.article_id = aa1.article_id
      JOIN "Author_Article" aa2 ON a.article_id = aa2.article_id AND aa1.author_id < aa2.author_id
      GROUP BY aa1.author_id, aa2.author_id
    `;

    // Query 4: Institution Edges (affiliations)
    const instEdgesQuery = `
      ${cteSql}
      SELECT 
        aa.author_id AS from_id, 
        ia.institution_id AS to_id, 
        COUNT(DISTINCT a.article_id)::integer AS weight
      FROM filtered_articles a
      JOIN "Author_Article" aa ON a.article_id = aa.article_id
      JOIN "Institution_Author" ia ON aa.author_id = ia.author_id AND ia.year = a.publication_year
      GROUP BY aa.author_id, ia.institution_id
    `;

    const [authNodesRes, instNodesRes, authEdgesRes, instEdgesRes] = await Promise.all([
      client.query(authorNodesQuery, params),
      client.query(instNodesQuery, params),
      client.query(authorEdgesQuery, params),
      client.query(instEdgesQuery, params)
    ]);

    const authNodes = [];
    const instNodes = [];
    const edgesMap = new Map();

    authNodesRes.rows.forEach(row => {
      const articleCount = Number(row.article_count);
      authNodes.push({
        id: `auth_${row.id}`,
        label: row.label || 'Unknown Author',
        type: 'AUTHOR',
        size: 12 + Math.min(articleCount * 2, 20),
        color: '#FF6B00',
        score: articleCount
      });
    });

    instNodesRes.rows.forEach(row => {
      const authorCount = Number(row.author_count);
      instNodes.push({
        id: `inst_${row.id}`,
        label: row.label || 'Unknown Institution',
        type: 'INSTITUTION',
        size: 12 + Math.min(authorCount * 2, 20),
        color: '#1A202C',
        score: authorCount
      });
    });

    // Sort separately
    authNodes.sort((a, b) => b.score - a.score);
    instNodes.sort((a, b) => b.score - a.score);

    // Split limit evenly
    const halfLimit = Math.floor(limitNodes / 2);
    
    // Nếu một bên không đủ số lượng halfLimit, nhường quota cho bên kia
    let finalAuthCount = Math.min(authNodes.length, halfLimit);
    let finalInstCount = Math.min(instNodes.length, halfLimit);
    
    if (finalAuthCount < halfLimit) {
      finalInstCount = Math.min(instNodes.length, limitNodes - finalAuthCount);
    } else if (finalInstCount < halfLimit) {
      finalAuthCount = Math.min(authNodes.length, limitNodes - finalInstCount);
    }

    const finalNodes = [
      ...authNodes.slice(0, finalAuthCount),
      ...instNodes.slice(0, finalInstCount)
    ];
    
    // Lưu lại trường score thay vì xóa, để dùng cho Tooltip
    finalNodes.forEach(n => {
      n.metricValue = n.score;
      delete n.score;
    });

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

    authEdgesRes.rows.forEach(row => {
      addEdge(`auth_${row.from_id}`, `auth_${row.to_id}`, Number(row.weight), 'joint ventures');
    });

    instEdgesRes.rows.forEach(row => {
      addEdge(`auth_${row.from_id}`, `inst_${row.to_id}`, Number(row.weight), 'affiliations');
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
    client.release();
  }
}
