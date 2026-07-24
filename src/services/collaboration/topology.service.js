import pool from '../../config/database.js';
import { redisGet, redisSet } from '../infrastructure/redis.service.js';
import logger from '../../utils/logger.js';

const CACHE_TTL = 43200; // 12 hours

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

    // Now, build CTE and execute queries in PostgreSQL
    const cteParts = [];
    const params = [];

    // 1. Project Scope topics / keywords
    const scopeSelects = [];
    if (projectTopicIds.length > 0) {
      params.push(projectTopicIds);
      const catIdx = params.length;
      scopeSelects.push(`
        SELECT a.article_id
        FROM "Article" a
        WHERE a.primary_topic = ANY($${catIdx}::bigint[]) AND COALESCE(a.is_deleted, false) = false
        UNION
        SELECT st.article_id
        FROM "Sub_Topic" st
        WHERE st.topic_id = ANY($${catIdx}::bigint[])
      `);
    }
    if (projectKwIds.length > 0) {
      params.push(projectKwIds);
      const kwIdx = params.length;
      scopeSelects.push(`
        SELECT article_id
        FROM "Keyword_Article"
        WHERE keyword_id = ANY($${kwIdx}::bigint[])
      `);
    }
    cteParts.push(`project_scope AS (${scopeSelects.join(' UNION ')})`);

    // 2. Client filter: subject_area
    if (filterTopicIds.length > 0) {
      params.push(filterTopicIds);
      const filterCatIdx = params.length;
      cteParts.push(`sa_filter AS (
        SELECT a.article_id FROM "Article" a
        WHERE a.primary_topic = ANY($${filterCatIdx}::bigint[]) AND COALESCE(a.is_deleted, false) = false
        UNION
        SELECT st.article_id FROM "Sub_Topic" st
        WHERE st.topic_id = ANY($${filterCatIdx}::bigint[])
      )`);
    }

    // 3. Client filter: keywords
    if (filterKeywordIds.length > 0) {
      params.push(filterKeywordIds);
      const filterKwIdx = params.length;
      cteParts.push(`kw_filter AS (
        SELECT article_id FROM "Keyword_Article" WHERE keyword_id = ANY($${filterKwIdx}::bigint[])
      )`);
    }

    // 4. Combine into filtered_articles
    const joinClauses = ['JOIN project_scope ps ON a.article_id = ps.article_id'];
    if (filterTopicIds.length > 0) {
      joinClauses.push('JOIN sa_filter saf ON a.article_id = saf.article_id');
    }
    if (filterKeywordIds.length > 0) {
      joinClauses.push('JOIN kw_filter kwf ON a.article_id = kwf.article_id');
    }

    const yearFilters = [];
    if (from_year) {
      params.push(Number(from_year));
      yearFilters.push(`a.publication_year >= $${params.length}`);
    }
    if (to_year) {
      params.push(Number(to_year));
      yearFilters.push(`a.publication_year <= $${params.length}`);
    }
    const yearWhere = yearFilters.length > 0 ? `AND ${yearFilters.join(' AND ')}` : '';

    cteParts.push(`filtered_articles AS (
      SELECT a.article_id
      FROM "Article" a
      ${joinClauses.join(' ')}
      WHERE COALESCE(a.is_deleted, false) = false ${yearWhere}
    )`);

    const cteSql = `WITH ${cteParts.join(', ')}`;

    let allNodes = [];
    let allEdges = [];

    const fetchConceptual = network_type === 'conceptual' || network_type === 'all';
    const fetchCollaboration = network_type === 'collaboration' || network_type === 'all';

    if (fetchConceptual) {
      const conceptNodesQuery = `
        ${cteSql}
        SELECT k.keyword_id AS id, k.display_name AS label, 'KEYWORD' AS type, COUNT(fa.article_id)::integer AS size
        FROM "Keyword" k
        JOIN "Keyword_Article" ka ON k.keyword_id = ka.keyword_id
        JOIN filtered_articles fa ON ka.article_id = fa.article_id
        GROUP BY k.keyword_id, k.display_name
      `;
      const conceptEdgesQuery = `
        ${cteSql}
        SELECT ka1.keyword_id AS from, ka2.keyword_id AS to, 'CONCEPTUAL_PROXIMITY' AS type, COUNT(fa.article_id)::integer AS weight
        FROM filtered_articles fa
        JOIN "Keyword_Article" ka1 ON fa.article_id = ka1.article_id
        JOIN "Keyword_Article" ka2 ON fa.article_id = ka2.article_id
        WHERE ka1.keyword_id < ka2.keyword_id
        GROUP BY ka1.keyword_id, ka2.keyword_id
      `;

      const nRes = await client.query(conceptNodesQuery, params);
      const eRes = await client.query(conceptEdgesQuery, params);

      nRes.rows.forEach(r => {
        allNodes.push({
          id: `kw_${r.id}`,
          label: r.label || 'Unknown',
          type: r.type,
          size: Number(r.size)
        });
      });

      eRes.rows.forEach(r => {
        allEdges.push({
          from: `kw_${r.from}`,
          to: `kw_${r.to}`,
          type: r.type,
          weight: Number(r.weight)
        });
      });
    }

    if (fetchCollaboration) {
      const collabNodesQuery = `
        ${cteSql}
        SELECT auth.author_id AS id, auth.display_name AS label, 'AUTHOR' AS type, COUNT(fa.article_id)::integer AS size
        FROM "Author" auth
        JOIN "Author_Article" aa ON auth.author_id = aa.author_id
        JOIN filtered_articles fa ON aa.article_id = fa.article_id
        GROUP BY auth.author_id, auth.display_name
      `;
      const collabEdgesQuery = `
        ${cteSql}
        SELECT aa1.author_id AS from, aa2.author_id AS to, 'CO_AUTHORSHIP' AS type, COUNT(fa.article_id)::integer AS weight
        FROM filtered_articles fa
        JOIN "Author_Article" aa1 ON fa.article_id = aa1.article_id
        JOIN "Author_Article" aa2 ON fa.article_id = aa2.article_id
        WHERE aa1.author_id < aa2.author_id
        GROUP BY aa1.author_id, aa2.author_id
      `;

      const nRes = await client.query(collabNodesQuery, params);
      const eRes = await client.query(collabEdgesQuery, params);

      nRes.rows.forEach(r => {
        allNodes.push({
          id: `auth_${r.id}`,
          label: r.label || 'Unknown',
          type: r.type,
          size: Number(r.size)
        });
      });

      eRes.rows.forEach(r => {
        allEdges.push({
          from: `auth_${r.from}`,
          to: `auth_${r.to}`,
          type: r.type,
          weight: Number(r.weight)
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
    client.release();
  }
}
