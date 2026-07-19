import pool from '../config/database.js';
import { getProjectScope } from './forecast.service.js';
import { redisGet, redisSet } from './redis.service.js';
import logger from '../utils/logger.js';

const SEARCH_TYPES = ['article', 'journal', 'author', 'institution', 'keyword', 'topic'];

const SEARCH_TYPE_UI = {
  article: {
    label: 'Bài báo',
    icon: 'file-text',
    detailPath: (id) => `/articles/${id}`,
  },
  journal: {
    label: 'Tạp chí',
    icon: 'book-open',
    detailPath: (id) => `/journals/${id}`,
  },
  author: {
    label: 'Tác giả',
    icon: 'user',
    detailPath: (id) => `/authors/${id}`,
  },
  institution: {
    label: 'Tổ chức',
    icon: 'building-2',
    detailPath: (id) => `/institutions/${id}`,
  },
  keyword: {
    label: 'Từ khóa',
    icon: 'tag',
    detailPath: (id) => `/keywords/${id}`,
  },
  topic: {
    label: 'Chủ đề',
    icon: 'network',
    detailPath: (id) => `/topics/${id}`,
  },
};

function escapeLikePattern(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

function textMatches(field, patternIndex) {
  // If field is known to have a gin_trgm index, avoid casting to text
  if (['a.title', 'a.abstract', 'a.doi', 'j.display_name', 'j_search.display_name', 'j_rank.display_name'].includes(field)) {
    return `${field} ILIKE $${patternIndex} ESCAPE '\\'`;
  }
  // Otherwise safely cast to text
  return `COALESCE(${field}::text, '') ILIKE $${patternIndex} ESCAPE '\\'`;
}

function textStartsWith(field, prefixIndex) {
  return `LOWER(${field}) LIKE $${prefixIndex} ESCAPE '\\'`;
}

function textExact(field, exactIndex) {
  return `LOWER(${field}) = $${exactIndex}`;
}

function buildSearchCondition(fields, patternIndex) {
  // Prioritize trgm matches
  return `(${fields.map((field) => textMatches(field, patternIndex)).join(' OR ')})`;
}

function buildArticleScopeCondition(params, scope, articleAlias = 'a') {
  const conditions = [];

  if (scope?.inScopeTopicIds?.length > 0) {
    params.push(scope.inScopeTopicIds);
    const index = params.length;
    conditions.push(`
      (
        ${articleAlias}.primary_topic = ANY($${index}::bigint[])
        OR EXISTS (
          SELECT 1
          FROM "Sub_Topic" st
          WHERE st.article_id = ${articleAlias}.article_id
            AND st.topic_id = ANY($${index}::bigint[])
        )
      )
    `);
  } else if (scope?.subjectCategoryIds?.length > 0) {
    params.push(scope.subjectCategoryIds);
    const index = params.length;
    conditions.push(`
      (
        EXISTS (
          SELECT 1
          FROM "Topic" primary_topic
          WHERE primary_topic.topic_id = ${articleAlias}.primary_topic
            AND primary_topic.subject_category_id = ANY($${index}::bigint[])
        )
        OR EXISTS (
          SELECT 1
          FROM "Sub_Topic" st
          JOIN "Topic" sub_topic ON st.topic_id = sub_topic.topic_id
          WHERE st.article_id = ${articleAlias}.article_id
            AND sub_topic.subject_category_id = ANY($${index}::bigint[])
        )
      )
    `);
  }

  if (scope?.keywordIds?.length > 0) {
    params.push(scope.keywordIds);
    const index = params.length;
    conditions.push(`
      EXISTS (
        SELECT 1
        FROM "Keyword_Article" ka
        WHERE ka.article_id = ${articleAlias}.article_id
          AND ka.keyword_id = ANY($${index}::bigint[])
      )
    `);
  }

  if (conditions.length === 0) {
    return 'FALSE';
  }

  return `(${conditions.join(' OR ')})`;
}

function buildArticleFilters(params, options = {}) {
  const {
    scope,
    fromYear,
    toYear,
    articleAlias = 'a',
    includeSoftDelete = false,
  } = options;
  const filters = [];

  if (includeSoftDelete) {
    filters.push(`COALESCE(${articleAlias}.is_deleted, false) = false`);
  }

  if (scope) {
    filters.push(buildArticleScopeCondition(params, scope, articleAlias));
  }

  if (fromYear !== undefined) {
    params.push(fromYear);
    filters.push(`${articleAlias}.publication_year >= $${params.length}`);
  }

  if (toYear !== undefined) {
    params.push(toYear);
    filters.push(`${articleAlias}.publication_year <= $${params.length}`);
  }

  return filters;
}

function buildArticleQuery(params, context, mode = 'light', ids = null) {
  const { exactIndex, prefixIndex, patternIndex, scope, fromYear, toYear } = context;

  if (mode === 'hydrate') {
    params.push(ids);
    const idsIndex = params.length;
    return `
      SELECT
        'article'::text AS entity_type,
        a.article_id::text AS entity_id,
        a.title::text AS title,
        NULLIF(a.abstract, '')::text AS description,
        a.publication_year::int AS publication_year,
        COALESCE(a.citation_count, 0)::bigint AS citation_count,
        jsonb_build_object(
          'doi', a.doi,
          'journalId', j.journal_id,
          'journalName', j.display_name,
          'referenceCount', a.reference_count,
          'influentialCitationCount', a.semantic_influential_citation_count,
          'semanticScholarId', a.semantic_scholar_id,
          'tldr', a.semantic_tldr,
          'authors', COALESCE((
            SELECT jsonb_agg(
              jsonb_build_object('id', author_rows.author_id, 'name', author_rows.display_name)
              ORDER BY author_rows.display_name
            )
            FROM (
              SELECT DISTINCT au.author_id, au.display_name
              FROM "Author_Article" aa
              JOIN "Author" au ON au.author_id = aa.author_id
              WHERE aa.article_id = a.article_id
                AND COALESCE(au.is_deleted, false) = false
            ) author_rows
          ), '[]'::jsonb),
          'keywords', COALESCE((
            SELECT jsonb_agg(keyword_rows.display_name ORDER BY keyword_rows.display_name)
            FROM (
              SELECT DISTINCT k.display_name
              FROM "Keyword_Article" ka
              JOIN "Keyword" k ON k.keyword_id = ka.keyword_id
              WHERE ka.article_id = a.article_id
            ) keyword_rows
          ), '[]'::jsonb)
        ) AS metadata,
        10::int AS relevance
      FROM "Article" a
      LEFT JOIN "Issue" iss ON iss.issue_id = a.issue_id
      LEFT JOIN "Volume" v ON v.volume_id = iss.volume_id
      LEFT JOIN "Journal" j ON j.journal_id = v.journal_id
      WHERE a.article_id = ANY($${idsIndex}::bigint[])
    `;
  }

  const hasScope = scope && (scope.inScopeTopicIds?.length > 0 || scope.subjectCategoryIds?.length > 0 || scope.keywordIds?.length > 0);

  if (hasScope) {
    const cteTopicIndex = scope.inScopeTopicIds?.length > 0 ? (params.push(scope.inScopeTopicIds), params.length) : null;
    const cteSubjectCategoryIndex = (!cteTopicIndex && scope.subjectCategoryIds?.length > 0) ? (params.push(scope.subjectCategoryIds), params.length) : null;
    const cteKeywordIndex = scope.keywordIds?.length > 0 ? (params.push(scope.keywordIds), params.length) : null;

    let unionParts = [];
    if (cteTopicIndex) {
      unionParts.push(`
        SELECT article_id FROM "Article" WHERE primary_topic = ANY($${cteTopicIndex}::bigint[]) AND COALESCE(is_deleted, false) = false
      `);
      unionParts.push(`
        SELECT article_id FROM "Sub_Topic" WHERE topic_id = ANY($${cteTopicIndex}::bigint[])
      `);
    } else if (cteSubjectCategoryIndex) {
      unionParts.push(`
        SELECT a.article_id FROM "Article" a
        JOIN "Topic" pt ON a.primary_topic = pt.topic_id
        WHERE pt.subject_category_id = ANY($${cteSubjectCategoryIndex}::bigint[]) AND COALESCE(a.is_deleted, false) = false
      `);
      unionParts.push(`
        SELECT st.article_id FROM "Sub_Topic" st
        JOIN "Topic" t ON st.topic_id = t.topic_id
        WHERE t.subject_category_id = ANY($${cteSubjectCategoryIndex}::bigint[])
      `);
    }
    if (cteKeywordIndex) {
      unionParts.push(`
        SELECT article_id FROM "Keyword_Article" WHERE keyword_id = ANY($${cteKeywordIndex}::bigint[])
      `);
    }

    const unionSql = unionParts.join('\n        UNION\n        ');

    const outerFilters = ['COALESCE(a.is_deleted, false) = false'];
    if (fromYear !== undefined) {
      params.push(fromYear);
      outerFilters.push(`a.publication_year >= $${params.length}`);
    }
    if (toYear !== undefined) {
      params.push(toYear);
      outerFilters.push(`a.publication_year <= $${params.length}`);
    }

    if (mode === 'count') {
      return `
        WITH in_scope_articles AS (
          ${unionSql}
        )
        SELECT COUNT(a.article_id)::int AS count
        FROM in_scope_articles isa
        JOIN "Article" a ON isa.article_id = a.article_id
        WHERE ${outerFilters.join('\n          AND ')}
          AND (
            ${buildSearchCondition(['a.title', 'a.abstract', 'a.doi'], patternIndex)}
            OR EXISTS (
              SELECT 1 FROM "Issue" iss_search
              JOIN "Volume" v_search ON v_search.volume_id = iss_search.volume_id
              JOIN "Journal" j_search ON j_search.journal_id = v_search.journal_id
              WHERE iss_search.issue_id = a.issue_id
                AND ${textMatches('j_search.display_name', patternIndex)}
            )
            OR EXISTS (
              SELECT 1 FROM "Author_Article" aa_search
              JOIN "Author" au_search ON au_search.author_id = aa_search.author_id
              WHERE aa_search.article_id = a.article_id
                AND COALESCE(au_search.is_deleted, false) = false
                AND ${textMatches('au_search.display_name', patternIndex)}
            )
            OR EXISTS (
              SELECT 1 FROM "Keyword_Article" ka_search
              JOIN "Keyword" k_search ON k_search.keyword_id = ka_search.keyword_id
              WHERE ka_search.article_id = a.article_id
                AND ${textMatches('k_search.display_name', patternIndex)}
            )
          )
      `;
    }

    return `
      WITH in_scope_articles AS (
        ${unionSql}
      )
      SELECT
        'article'::text AS entity_type,
        a.article_id::text AS entity_id,
        a.title::text AS title,
        NULLIF(a.abstract, '')::text AS description,
        a.publication_year::int AS publication_year,
        COALESCE(a.citation_count, 0)::bigint AS citation_count,
        CASE
          WHEN ${textExact('a.title', exactIndex)} THEN 100
          WHEN ${textStartsWith('a.title', prefixIndex)} THEN 85
          WHEN ${textMatches('a.title', patternIndex)} THEN 70
          WHEN ${textMatches('a.doi', patternIndex)} THEN 65
          WHEN EXISTS (
            SELECT 1 FROM "Issue" iss_rank
            JOIN "Volume" v_rank ON v_rank.volume_id = iss_rank.volume_id
            JOIN "Journal" j_rank ON j_rank.journal_id = v_rank.journal_id
            WHERE iss_rank.issue_id = a.issue_id
              AND ${textMatches('j_rank.display_name', patternIndex)}
          )
            OR EXISTS (
              SELECT 1 FROM "Author_Article" aa_rank
              JOIN "Author" au_rank ON au_rank.author_id = aa_rank.author_id
              WHERE aa_rank.article_id = a.article_id
                AND COALESCE(au_rank.is_deleted, false) = false
                AND ${textMatches('au_rank.display_name', patternIndex)}
            )
            OR EXISTS (
              SELECT 1 FROM "Keyword_Article" ka_rank
              JOIN "Keyword" k_rank ON k_rank.keyword_id = ka_rank.keyword_id
              WHERE ka_rank.article_id = a.article_id
                AND ${textMatches('k_rank.display_name', patternIndex)}
            ) THEN 50
          WHEN ${textMatches('a.abstract', patternIndex)} THEN 30
          ELSE 10
        END::int AS relevance
      FROM in_scope_articles isa
      JOIN "Article" a ON isa.article_id = a.article_id
      WHERE ${outerFilters.join('\n        AND ')}
        AND (
          ${buildSearchCondition(['a.title', 'a.abstract', 'a.doi'], patternIndex)}
          OR EXISTS (
            SELECT 1 FROM "Issue" iss_search
            JOIN "Volume" v_search ON v_search.volume_id = iss_search.volume_id
            JOIN "Journal" j_search ON j_search.journal_id = v_search.journal_id
            WHERE iss_search.issue_id = a.issue_id
              AND ${textMatches('j_search.display_name', patternIndex)}
          )
          OR EXISTS (
            SELECT 1 FROM "Author_Article" aa_search
            JOIN "Author" au_search ON au_search.author_id = aa_search.author_id
            WHERE aa_search.article_id = a.article_id
              AND COALESCE(au_search.is_deleted, false) = false
              AND ${textMatches('au_search.display_name', patternIndex)}
          )
          OR EXISTS (
            SELECT 1 FROM "Keyword_Article" ka_search
            JOIN "Keyword" k_search ON k_search.keyword_id = ka_search.keyword_id
            WHERE ka_search.article_id = a.article_id
              AND ${textMatches('k_search.display_name', patternIndex)}
          )
        )
    `;
  }

  const filters = buildArticleFilters(params, {
    scope: null,
    fromYear,
    toYear,
    articleAlias: 'a',
    includeSoftDelete: true,
  });

  if (mode === 'count') {
    return `
      SELECT COUNT(a.article_id)::int AS count
      FROM "Article" a
      WHERE ${filters.join('\n        AND ')}
        AND (
          ${buildSearchCondition(['a.title', 'a.abstract', 'a.doi'], patternIndex)}
          OR EXISTS (
            SELECT 1 FROM "Issue" iss_search
            JOIN "Volume" v_search ON v_search.volume_id = iss_search.volume_id
            JOIN "Journal" j_search ON j_search.journal_id = v_search.journal_id
            WHERE iss_search.issue_id = a.issue_id
              AND ${textMatches('j_search.display_name', patternIndex)}
          )
          OR EXISTS (
            SELECT 1 FROM "Author_Article" aa_search
            JOIN "Author" au_search ON au_search.author_id = aa_search.author_id
            WHERE aa_search.article_id = a.article_id
              AND COALESCE(au_search.is_deleted, false) = false
              AND ${textMatches('au_search.display_name', patternIndex)}
          )
          OR EXISTS (
            SELECT 1 FROM "Keyword_Article" ka_search
            JOIN "Keyword" k_search ON k_search.keyword_id = ka_search.keyword_id
            WHERE ka_search.article_id = a.article_id
              AND ${textMatches('k_search.display_name', patternIndex)}
          )
        )
    `;
  }

  return `
    SELECT
      'article'::text AS entity_type,
      a.article_id::text AS entity_id,
      a.title::text AS title,
      NULLIF(a.abstract, '')::text AS description,
      a.publication_year::int AS publication_year,
      COALESCE(a.citation_count, 0)::bigint AS citation_count,
      CASE
        WHEN ${textExact('a.title', exactIndex)} THEN 100
        WHEN ${textStartsWith('a.title', prefixIndex)} THEN 85
        WHEN ${textMatches('a.title', patternIndex)} THEN 70
        WHEN ${textMatches('a.doi', patternIndex)} THEN 65
        WHEN EXISTS (
          SELECT 1
          FROM "Issue" iss_rank
          JOIN "Volume" v_rank ON v_rank.volume_id = iss_rank.volume_id
          JOIN "Journal" j_rank ON j_rank.journal_id = v_rank.journal_id
          WHERE iss_rank.issue_id = a.issue_id
            AND ${textMatches('j_rank.display_name', patternIndex)}
        )
          OR EXISTS (
            SELECT 1
            FROM "Author_Article" aa_rank
            JOIN "Author" au_rank ON au_rank.author_id = aa_rank.author_id
            WHERE aa_rank.article_id = a.article_id
              AND COALESCE(au_rank.is_deleted, false) = false
              AND ${textMatches('au_rank.display_name', patternIndex)}
          )
          OR EXISTS (
            SELECT 1
            FROM "Keyword_Article" ka_rank
            JOIN "Keyword" k_rank ON k_rank.keyword_id = ka_rank.keyword_id
            WHERE ka_rank.article_id = a.article_id
              AND ${textMatches('k_rank.display_name', patternIndex)}
          ) THEN 50
        WHEN ${textMatches('a.abstract', patternIndex)} THEN 30
        ELSE 10
      END::int AS relevance
    FROM "Article" a
    WHERE ${filters.join('\n      AND ')}
      AND (
        ${buildSearchCondition(['a.title', 'a.abstract', 'a.doi'], patternIndex)}
        OR EXISTS (
          SELECT 1 FROM "Issue" iss_search
          JOIN "Volume" v_search ON v_search.volume_id = iss_search.volume_id
          JOIN "Journal" j_search ON j_search.journal_id = v_search.journal_id
          WHERE iss_search.issue_id = a.issue_id
            AND ${textMatches('j_search.display_name', patternIndex)}
        )
        OR EXISTS (
          SELECT 1 FROM "Author_Article" aa_search
          JOIN "Author" au_search ON au_search.author_id = aa_search.author_id
          WHERE aa_search.article_id = a.article_id
            AND COALESCE(au_search.is_deleted, false) = false
            AND ${textMatches('au_search.display_name', patternIndex)}
        )
        OR EXISTS (
          SELECT 1 FROM "Keyword_Article" ka_search
          JOIN "Keyword" k_search ON k_search.keyword_id = ka_search.keyword_id
          WHERE ka_search.article_id = a.article_id
            AND ${textMatches('k_search.display_name', patternIndex)}
        )
      )
  `;
}

function buildJournalQuery(params, context, mode = 'light', ids = null) {
  const { exactIndex, prefixIndex, patternIndex, scope, fromYear, toYear } = context;
  const filters = [
    'COALESCE(j.is_deleted, false) = false',
    buildSearchCondition(['j.display_name', 'j.issn', 'j.country', 'j.region', 'j.type', 'p.display_name'], patternIndex),
  ];

  if (mode === 'hydrate') {
    params.push(ids);
    const idsIndex = params.length;
    return `
      SELECT
        'journal'::text AS entity_type,
        j.journal_id::text AS entity_id,
        j.display_name::text AS title,
        p.display_name::text AS description,
        MAX(a.publication_year)::int AS publication_year,
        COALESCE(SUM(COALESCE(a.citation_count, 0)), 0)::bigint AS citation_count,
        jsonb_build_object(
          'sourceId', j.source_id,
          'publisherId', p.publisher_id,
          'publisher', p.display_name,
          'publisherImageUrl', p.image_url,
          'country', j.country,
          'region', j.region,
          'journalType', j.type,
          'isOpenAccess', COALESCE(j.is_open_access, false),
          'isOaDiamond', COALESCE(j.is_oa_diamond, false),
          'issn', j.issn,
          'articleCount', COUNT(DISTINCT a.article_id),
          'latestQuartile', (
            SELECT jr.value_txt
            FROM "Journal_Ranking" jr
            JOIN "Ranking_Metric" rm ON rm.metric_id = jr.metric_id
            WHERE jr.journal_id = j.journal_id
              AND rm.code IN ('SJR_BEST_QUARTILE', 'QUARTILE')
            ORDER BY jr.year DESC NULLS LAST
            LIMIT 1
          )
        ) AS metadata,
        30::int AS relevance
      FROM "Journal" j
      LEFT JOIN "Publisher" p ON p.publisher_id = j.publisher_id
      LEFT JOIN "Volume" v ON v.journal_id = j.journal_id AND COALESCE(v.is_deleted, false) = false
      LEFT JOIN "Issue" iss ON iss.volume_id = v.volume_id AND COALESCE(iss.is_deleted, false) = false
      LEFT JOIN "Article" a ON a.issue_id = iss.issue_id AND COALESCE(a.is_deleted, false) = false
      WHERE j.journal_id = ANY($${idsIndex}::bigint[])
      GROUP BY j.journal_id, j.source_id, j.display_name, j.issn, j.country, j.region, j.type, j.is_open_access, j.is_oa_diamond, p.publisher_id, p.display_name, p.image_url
    `;
  }

  const hasScopeOrYear = scope || fromYear !== undefined || toYear !== undefined;

  if (mode === 'count') {
    if (hasScopeOrYear) {
      const articleFilters = buildArticleFilters(params, { scope, fromYear, toYear, articleAlias: 'a' });
      filters.push(`
        EXISTS (
          SELECT 1
          FROM "Volume" v
          JOIN "Issue" iss ON iss.volume_id = v.volume_id AND COALESCE(iss.is_deleted, false) = false
          JOIN "Article" a ON a.issue_id = iss.issue_id AND COALESCE(a.is_deleted, false) = false
          WHERE v.journal_id = j.journal_id
            AND COALESCE(v.is_deleted, false) = false
            AND ${articleFilters.join(' AND ')}
        )
      `);
    }
    return `
      SELECT COUNT(j.journal_id)::int AS count
      FROM "Journal" j
      LEFT JOIN "Publisher" p ON p.publisher_id = j.publisher_id
      WHERE ${filters.join('\n        AND ')} 
    `;
  }

  if (hasScopeOrYear) {
    const articleFilters = buildArticleFilters(params, { scope, fromYear, toYear, articleAlias: 'a' });
    filters.push(`
      EXISTS (
        SELECT 1
        FROM "Volume" v
        JOIN "Issue" iss ON iss.volume_id = v.volume_id AND COALESCE(iss.is_deleted, false) = false
        JOIN "Article" a ON a.issue_id = iss.issue_id AND COALESCE(a.is_deleted, false) = false
        WHERE v.journal_id = j.journal_id
          AND COALESCE(v.is_deleted, false) = false
          AND ${articleFilters.join(' AND ')}
      )
    `);
  }

  return `
    SELECT
      'journal'::text AS entity_type,
      j.journal_id::text AS entity_id,
      j.display_name::text AS title,
      p.display_name::text AS description,
      NULL::int AS publication_year,
      0::bigint AS citation_count,
      CASE
        WHEN ${textExact('j.display_name', exactIndex)} THEN 100
        WHEN ${textStartsWith('j.display_name', prefixIndex)} THEN 85
        WHEN ${textMatches('j.display_name', patternIndex)} THEN 70
        WHEN ${textMatches('j.issn', patternIndex)} THEN 60
        WHEN ${textMatches('p.display_name', patternIndex)} THEN 45
        ELSE 30
      END::int AS relevance
    FROM "Journal" j
    LEFT JOIN "Publisher" p ON p.publisher_id = j.publisher_id
    WHERE ${filters.join('\n      AND ')}
  `;
}

function buildAuthorQuery(params, context, mode = 'light', ids = null) {
  const { exactIndex, prefixIndex, patternIndex, scope, fromYear, toYear } = context;
  const filters = [
    'COALESCE(au.is_deleted, false) = false',
    buildSearchCondition(['au.display_name', 'au.orcid', 'au.openalex_id'], patternIndex),
  ];

  if (mode === 'hydrate') {
    params.push(ids);
    const idsIndex = params.length;
    return `
      SELECT
        'author'::text AS entity_type,
        au.author_id::text AS entity_id,
        au.display_name::text AS title,
        au.orcid::text AS description,
        MAX(a.publication_year)::int AS publication_year,
        COALESCE(SUM(DISTINCT COALESCE(a.citation_count, 0)), 0)::bigint AS citation_count,
        jsonb_build_object(
          'orcid', au.orcid,
          'openalexId', au.openalex_id,
          'urlImage', au.url_image,
          'worksCount', au.works_count,
          'citedByCount', au.cited_by_count,
          'hIndex', au.h_index,
          'i10Index', au.i10_index,
          'lastKnownInstitution', au.last_known_institution,
          'lastKnownInstitutionId', au.last_known_institution_id,
          'articleCount', COUNT(DISTINCT a.article_id),
          'institutions', COALESCE((
            SELECT jsonb_agg(
              jsonb_build_object('id', institution_rows.institution_id, 'name', institution_rows.display_name, 'countryCode', institution_rows.country_code)
              ORDER BY institution_rows.display_name
            )
            FROM (
              SELECT DISTINCT ins.institution_id, ins.display_name, ins.country_code
              FROM "Institution_Author" ia
              JOIN "Institution" ins ON ins.institution_id = ia.institution_id
              WHERE ia.author_id = au.author_id
                AND COALESCE(ins.is_deleted, false) = false
              LIMIT 5
            ) institution_rows
          ), '[]'::jsonb)
        ) AS metadata,
        30::int AS relevance
      FROM "Author" au
      LEFT JOIN "Author_Article" aa ON aa.author_id = au.author_id
      LEFT JOIN "Article" a ON a.article_id = aa.article_id AND COALESCE(a.is_deleted, false) = false
      WHERE au.author_id = ANY($${idsIndex}::bigint[])
      GROUP BY au.author_id, au.display_name, au.orcid, au.openalex_id, au.url_image, au.works_count, au.cited_by_count, au.h_index, au.i10_index, au.last_known_institution, au.last_known_institution_id
    `;
  }

  const hasScopeOrYear = scope || fromYear !== undefined || toYear !== undefined;

  if (mode === 'count') {
    if (hasScopeOrYear) {
      const articleFilters = buildArticleFilters(params, { scope, fromYear, toYear, articleAlias: 'a' });
      filters.push(`
        EXISTS (
          SELECT 1
          FROM "Author_Article" aa
          JOIN "Article" a ON a.article_id = aa.article_id AND COALESCE(a.is_deleted, false) = false
          WHERE aa.author_id = au.author_id
            AND ${articleFilters.join(' AND ')}
        )
      `);
    }
    return ` 
      SELECT COUNT(au.author_id)::int AS count
      FROM "Author" au
      WHERE ${filters.join('\n        AND ')}
    `;
  }

  if (hasScopeOrYear) {
    const articleFilters = buildArticleFilters(params, { scope, fromYear, toYear, articleAlias: 'a' });
    filters.push(`
      EXISTS (
        SELECT 1
        FROM "Author_Article" aa
        JOIN "Article" a ON a.article_id = aa.article_id AND COALESCE(a.is_deleted, false) = false
        WHERE aa.author_id = au.author_id
          AND ${articleFilters.join(' AND ')}
      )
    `);
  }

  return `
    SELECT
      'author'::text AS entity_type,
      au.author_id::text AS entity_id,
      au.display_name::text AS title,
      au.orcid::text AS description,
      NULL::int AS publication_year,
      0::bigint AS citation_count,
      CASE
        WHEN ${textExact('au.display_name', exactIndex)} THEN 100
        WHEN ${textStartsWith('au.display_name', prefixIndex)} THEN 85
        WHEN ${textMatches('au.display_name', patternIndex)} THEN 70
        WHEN ${textMatches('au.orcid', patternIndex)} THEN 60
        ELSE 30
      END::int AS relevance
    FROM "Author" au
    WHERE ${filters.join('\n      AND ')}
  `;
}

function buildInstitutionQuery(params, context, mode = 'light', ids = null) {
  const { exactIndex, prefixIndex, patternIndex, scope, fromYear, toYear } = context;
  const filters = [
    'COALESCE(ins.is_deleted, false) = false',
    buildSearchCondition(['ins.display_name', 'ins.country_code', 'ins.type'], patternIndex),
  ];

  if (mode === 'hydrate') {
    params.push(ids);
    const idsIndex = params.length;
    return `
      SELECT
        'institution'::text AS entity_type,
        ins.institution_id::text AS entity_id,
        ins.display_name::text AS title,
        ins.country_code::text AS description,
        MAX(a.publication_year)::int AS publication_year,
        COALESCE(SUM(DISTINCT COALESCE(a.citation_count, 0)), 0)::bigint AS citation_count,
        jsonb_build_object(
          'openalexId', NULL::text,
          'countryCode', ins.country_code,
          'institutionType', ins.type,
          'authorCount', COUNT(DISTINCT ia.author_id),
          'articleCount', COUNT(DISTINCT a.article_id)
        ) AS metadata,
        30::int AS relevance
      FROM "Institution" ins
      LEFT JOIN "Institution_Author" ia ON ia.institution_id = ins.institution_id
      LEFT JOIN "Author_Article" aa ON aa.author_id = ia.author_id
      LEFT JOIN "Article" a ON a.article_id = aa.article_id AND COALESCE(a.is_deleted, false) = false
      WHERE ins.institution_id = ANY($${idsIndex}::bigint[])
      GROUP BY ins.institution_id, ins.display_name, ins.country_code, ins.type
    `;
  }

  const hasScopeOrYear = scope || fromYear !== undefined || toYear !== undefined;

  if (mode === 'count') {
    if (hasScopeOrYear) {
      const articleFilters = buildArticleFilters(params, { scope, fromYear, toYear, articleAlias: 'a' });
      filters.push(`
        EXISTS (
          SELECT 1
          FROM "Institution_Author" ia
          JOIN "Author_Article" aa ON aa.author_id = ia.author_id
          JOIN "Article" a ON a.article_id = aa.article_id AND COALESCE(a.is_deleted, false) = false
          WHERE ia.institution_id = ins.institution_id
            AND ${articleFilters.join(' AND ')}
        )
      `);
    }
    return ` 
      SELECT COUNT(ins.institution_id)::int AS count
      FROM "Institution" ins
      WHERE ${filters.join('\n        AND ')}
    `;
  }

  if (hasScopeOrYear) {
    const articleFilters = buildArticleFilters(params, { scope, fromYear, toYear, articleAlias: 'a' });
    filters.push(`
      EXISTS (
        SELECT 1
        FROM "Institution_Author" ia
        JOIN "Author_Article" aa ON aa.author_id = ia.author_id
        JOIN "Article" a ON a.article_id = aa.article_id AND COALESCE(a.is_deleted, false) = false
        WHERE ia.institution_id = ins.institution_id
          AND ${articleFilters.join(' AND ')}
      )
    `);
  }

  return `
    SELECT
      'institution'::text AS entity_type,
      ins.institution_id::text AS entity_id,
      ins.display_name::text AS title,
      ins.country_code::text AS description,
      NULL::int AS publication_year,
      0::bigint AS citation_count,
      CASE
        WHEN ${textExact('ins.display_name', exactIndex)} THEN 100
        WHEN ${textStartsWith('ins.display_name', prefixIndex)} THEN 85
        WHEN ${textMatches('ins.display_name', patternIndex)} THEN 70
        WHEN ${textMatches('ins.country_code', patternIndex)} THEN 45
        ELSE 30
      END::int AS relevance
    FROM "Institution" ins
    WHERE ${filters.join('\n      AND ')}
  `;
}

function buildKeywordQuery(params, context, mode = 'light', ids = null) {
  const { exactIndex, prefixIndex, patternIndex, scope, fromYear, toYear } = context;
  const filters = [
    buildSearchCondition(['k.display_name'], patternIndex),
  ];

  if (mode === 'hydrate') {
    params.push(ids);
    const idsIndex = params.length;
    return `
      SELECT
        'keyword'::text AS entity_type,
        k.keyword_id::text AS entity_id,
        k.display_name::text AS title,
        NULL::text AS description,
        MAX(a.publication_year)::int AS publication_year,
        COALESCE(SUM(DISTINCT COALESCE(a.citation_count, 0)), 0)::bigint AS citation_count,
        jsonb_build_object(
          'articleCount', COUNT(DISTINCT a.article_id)
        ) AS metadata,
        30::int AS relevance
      FROM "Keyword" k
      LEFT JOIN "Keyword_Article" ka ON ka.keyword_id = k.keyword_id
      LEFT JOIN "Article" a ON a.article_id = ka.article_id AND COALESCE(a.is_deleted, false) = false
      WHERE k.keyword_id = ANY($${idsIndex}::bigint[])
      GROUP BY k.keyword_id, k.display_name
    `;
  }

  const hasScopeOrYear = scope || fromYear !== undefined || toYear !== undefined;

  if (mode === 'count') {
    if (hasScopeOrYear) {
      const articleFilters = buildArticleFilters(params, { scope, fromYear, toYear, articleAlias: 'a' });
      filters.push(`
        EXISTS (
          SELECT 1
          FROM "Keyword_Article" ka
          JOIN "Article" a ON a.article_id = ka.article_id AND COALESCE(a.is_deleted, false) = false
          WHERE ka.keyword_id = k.keyword_id
            AND ${articleFilters.join(' AND ')}
        )
      `);
    }
    return ` 
      SELECT COUNT(k.keyword_id)::int AS count
      FROM "Keyword" k
      WHERE ${filters.join('\n        AND ')}
    `;
  }

  if (hasScopeOrYear) {
    const articleFilters = buildArticleFilters(params, { scope, fromYear, toYear, articleAlias: 'a' });
    filters.push(`
      EXISTS (
        SELECT 1
        FROM "Keyword_Article" ka
        JOIN "Article" a ON a.article_id = ka.article_id AND COALESCE(a.is_deleted, false) = false
        WHERE ka.keyword_id = k.keyword_id
          AND ${articleFilters.join(' AND ')}
      )
    `);
  }

  return `
    SELECT
      'keyword'::text AS entity_type,
      k.keyword_id::text AS entity_id,
      k.display_name::text AS title,
      NULL::text AS description,
      NULL::int AS publication_year,
      0::bigint AS citation_count,
      CASE
        WHEN ${textExact('k.display_name', exactIndex)} THEN 100
        WHEN ${textStartsWith('k.display_name', prefixIndex)} THEN 85
        WHEN ${textMatches('k.display_name', patternIndex)} THEN 70
        ELSE 30
      END::int AS relevance
    FROM "Keyword" k
    WHERE ${filters.join('\n      AND ')}
  `;
}

function buildTopicQuery(params, context, mode = 'light', ids = null) {
  const { exactIndex, prefixIndex, patternIndex, scope, fromYear, toYear } = context;
  const filters = [
    'COALESCE(t.is_deleted, false) = false',
    buildSearchCondition(['t.display_name', 'sc.display_name', 'sa.display_name'], patternIndex),
  ];

  if (mode === 'hydrate') {
    params.push(ids);
    const idsIndex = params.length;
    return `
      SELECT
        'topic'::text AS entity_type,
        t.topic_id::text AS entity_id,
        t.display_name::text AS title,
        sc.display_name::text AS description,
        MAX(a.publication_year)::int AS publication_year,
        COALESCE(SUM(DISTINCT COALESCE(a.citation_count, 0)), 0)::bigint AS citation_count,
        jsonb_build_object(
          'score', t.score,
          'subjectCategoryId', sc.subject_category_id,
          'subjectCategoryName', sc.display_name,
          'subjectAreaId', sa.subject_area_id,
          'subjectAreaName', sa.display_name,
          'articleCount', COUNT(DISTINCT a.article_id)
        ) AS metadata,
        30::int AS relevance
      FROM "Topic" t
      LEFT JOIN "Subject_Category" sc ON sc.subject_category_id = t.subject_category_id
      LEFT JOIN "Subject_Area" sa ON sa.subject_area_id = sc.subject_area_id
      LEFT JOIN (
        SELECT primary_topic AS topic_id, article_id, publication_year, citation_count, is_deleted FROM "Article"
        UNION ALL
        SELECT st.topic_id, a.article_id, a.publication_year, a.citation_count, a.is_deleted
        FROM "Sub_Topic" st
        JOIN "Article" a ON st.article_id = a.article_id
      ) a ON a.topic_id = t.topic_id AND COALESCE(a.is_deleted, false) = false
      WHERE t.topic_id = ANY($${idsIndex}::bigint[])
      GROUP BY t.topic_id, t.display_name, t.score, sc.subject_category_id, sc.display_name, sa.subject_area_id, sa.display_name
    `;
  }

  const hasScopeOrYear = scope || fromYear !== undefined || toYear !== undefined;

  if (mode === 'count') {
    if (hasScopeOrYear) {
      const articleFilters = buildArticleFilters(params, { scope, fromYear, toYear, articleAlias: 'a' });
      filters.push(`
        (
          EXISTS (
            SELECT 1 FROM "Article" a
            WHERE a.primary_topic = t.topic_id AND COALESCE(a.is_deleted, false) = false
              AND ${articleFilters.join(' AND ')}
          )
          OR EXISTS (
            SELECT 1 FROM "Sub_Topic" st
            JOIN "Article" a ON st.article_id = a.article_id AND COALESCE(a.is_deleted, false) = false
            WHERE st.topic_id = t.topic_id
              AND ${articleFilters.join(' AND ')}
          )
        )
      `);
    }
    return `
      SELECT COUNT(t.topic_id)::int AS count
      FROM "Topic" t
      LEFT JOIN "Subject_Category" sc ON sc.subject_category_id = t.subject_category_id
      LEFT JOIN "Subject_Area" sa ON sa.subject_area_id = sc.subject_area_id
      WHERE ${filters.join('\n        AND ')}
    `;
  }

  if (hasScopeOrYear) {
    const articleFilters = buildArticleFilters(params, { scope, fromYear, toYear, articleAlias: 'a' });
    filters.push(`
      (
        EXISTS (
          SELECT 1 FROM "Article" a
          WHERE a.primary_topic = t.topic_id AND COALESCE(a.is_deleted, false) = false
            AND ${articleFilters.join(' AND ')}
        )
        OR EXISTS (
          SELECT 1 FROM "Sub_Topic" st
          JOIN "Article" a ON st.article_id = a.article_id AND COALESCE(a.is_deleted, false) = false
          WHERE st.topic_id = t.topic_id
            AND ${articleFilters.join(' AND ')}
        )
      )
    `);
  }

  return `
    SELECT
      'topic'::text AS entity_type,
      t.topic_id::text AS entity_id,
      t.display_name::text AS title,
      sc.display_name::text AS description,
      NULL::int AS publication_year,
      0::bigint AS citation_count,
      CASE
        WHEN ${textExact('t.display_name', exactIndex)} THEN 100
        WHEN ${textStartsWith('t.display_name', prefixIndex)} THEN 85
        WHEN ${textMatches('t.display_name', patternIndex)} THEN 70
        WHEN ${textMatches('sc.display_name', patternIndex)} OR ${textMatches('sa.display_name', patternIndex)} THEN 45
        ELSE 30
      END::int AS relevance
    FROM "Topic" t
    LEFT JOIN "Subject_Category" sc ON sc.subject_category_id = t.subject_category_id
    LEFT JOIN "Subject_Area" sa ON sa.subject_area_id = sc.subject_area_id
    WHERE ${filters.join('\n      AND ')}
  `;
}

const BRANCH_BUILDERS = {
  article: buildArticleQuery,
  journal: buildJournalQuery,
  author: buildAuthorQuery,
  institution: buildInstitutionQuery,
  keyword: buildKeywordQuery,
  topic: buildTopicQuery,
};

function getOrderBy(sort) {
  switch (sort) {
    case 'year_desc':
      return 'publication_year DESC NULLS LAST, relevance DESC, citation_count DESC NULLS LAST, title ASC';
    case 'citations_desc':
      return 'citation_count DESC NULLS LAST, relevance DESC, publication_year DESC NULLS LAST, title ASC';
    case 'name_asc':
      return 'title ASC, relevance DESC, publication_year DESC NULLS LAST';
    case 'relevance':
    default:
      return 'relevance DESC, citation_count DESC NULLS LAST, publication_year DESC NULLS LAST, title ASC';
  }
}

function normalizeCounts(rawCounts = {}, selectedTypes) {
  const counts = {};
  for (const type of selectedTypes) {
    counts[type] = Number(rawCounts[type] || 0);
  }
  return counts;
}

function cleanText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text || null;
}

function truncateText(value, maxLength = 240) {
  const text = cleanText(value);
  if (!text) return null;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3).trim()}...`;
}

function compact(values) {
  return values
    .map((value) => cleanText(value))
    .filter(Boolean);
}

function joinParts(values) {
  const parts = compact(values);
  return parts.length > 0 ? parts.join(' | ') : null;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function getNames(values, max = 3) {
  return toArray(values)
    .map((item) => (typeof item === 'string' ? item : item?.name))
    .map((name) => cleanText(name))
    .filter(Boolean)
    .slice(0, max);
}

function getTldrText(tldr) {
  if (!tldr) return null;
  if (typeof tldr === 'string') return tldr;
  if (typeof tldr === 'object') {
    return tldr.text || tldr.description || tldr.summary || null;
  }
  return null;
}

function makeBadge(label, value, variant = 'neutral') {
  const cleanedValue = cleanText(value);
  if (!cleanedValue) return null;
  return { label, value: cleanedValue, variant };
}

function formatMetricValue(value, options = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return cleanText(value);
  }

  if (Number.isInteger(value) && Math.abs(value) < 1000) {
    return String(value);
  }

  if (options.compact !== false && Math.abs(value) >= 1000) {
    return new Intl.NumberFormat('en-US', {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value);
  }

  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2,
  }).format(value);
}

function makeStat(label, value, suffix = null) {
  if (value === undefined || value === null || value === '') return null;
  const numericValue = Number(value);
  const normalizedValue = Number.isNaN(numericValue) ? value : numericValue;
  const isYearStat = /year/i.test(label);
  const displayValue = isYearStat ? cleanText(normalizedValue) : formatMetricValue(normalizedValue);

  return {
    label,
    value: normalizedValue,
    displayValue: suffix && displayValue ? `${displayValue} ${suffix}` : displayValue,
    suffix,
  };
}

function addLatestYearStat(item) {
  return item.publicationYear ? makeStat('Latest year', item.publicationYear) : null;
}

function buildArticleUi(item, metadata) {
  const authorNames = getNames(metadata.authors, 3);
  const authorText = authorNames.length > 0 ? authorNames.join(', ') : null;

  return {
    subtitle: joinParts([authorText, metadata.journalName, item.publicationYear]),
    snippet: truncateText(getTldrText(metadata.tldr) || item.description),
    imageUrl: null,
    badges: [
      makeBadge('Year', item.publicationYear),
      makeBadge('Journal', metadata.journalName),
      makeBadge('DOI', metadata.doi),
    ].filter(Boolean),
    stats: [
      makeStat('Citations', item.citationCount),
      makeStat('Influential citations', metadata.influentialCitationCount),
      makeStat('References', metadata.referenceCount),
    ].filter(Boolean),
  };
}

function buildJournalUi(item, metadata) {
  return {
    subtitle: joinParts([metadata.publisher, metadata.country, metadata.journalType]),
    snippet: joinParts([
      metadata.issn ? `ISSN ${metadata.issn}` : null,
      metadata.latestQuartile ? `Quartile ${metadata.latestQuartile}` : null,
      metadata.isOpenAccess ? 'Open access' : null,
    ]),
    imageUrl: metadata.publisherImageUrl || null,
    badges: [
      makeBadge('Quartile', metadata.latestQuartile, 'rank'),
      makeBadge('Open access', metadata.isOpenAccess ? 'Yes' : null, 'success'),
      makeBadge('Country', metadata.country),
      makeBadge('ISSN', metadata.issn),
    ].filter(Boolean),
    stats: [
      makeStat('Articles', metadata.articleCount),
      makeStat('Citations', item.citationCount),
      addLatestYearStat(item),
    ].filter(Boolean),
  };
}

function buildAuthorUi(item, metadata) {
  const institutionNames = getNames(metadata.institutions, 2);
  const institutionText = metadata.lastKnownInstitution || institutionNames.join(', ');

  return {
    subtitle: joinParts([institutionText, metadata.orcid ? `ORCID ${metadata.orcid}` : null]),
    snippet: joinParts([
      metadata.worksCount !== undefined ? `${metadata.worksCount} works` : null,
      metadata.citedByCount !== undefined ? `${metadata.citedByCount} citations` : null,
      metadata.hIndex !== undefined ? `H-index ${metadata.hIndex}` : null,
    ]),
    imageUrl: metadata.urlImage || null,
    badges: [
      makeBadge('ORCID', metadata.orcid),
      makeBadge('H-index', metadata.hIndex),
      makeBadge('Institution', institutionText),
    ].filter(Boolean),
    stats: [
      makeStat('Works', metadata.worksCount),
      makeStat('Citations', metadata.citedByCount ?? item.citationCount),
      makeStat('H-index', metadata.hIndex),
      makeStat('Articles', metadata.articleCount),
    ].filter(Boolean),
  };
}

function buildInstitutionUi(item, metadata) {
  return {
    subtitle: joinParts([metadata.countryCode, metadata.institutionType]),
    snippet: joinParts([
      metadata.authorCount !== undefined ? `${metadata.authorCount} authors` : null,
      metadata.articleCount !== undefined ? `${metadata.articleCount} articles` : null,
    ]),
    imageUrl: null,
    badges: [
      makeBadge('Country', metadata.countryCode),
      makeBadge('Type', metadata.institutionType),
      makeBadge('OpenAlex', metadata.openalexId),
    ].filter(Boolean),
    stats: [
      makeStat('Authors', metadata.authorCount),
      makeStat('Articles', metadata.articleCount),
      makeStat('Citations', item.citationCount),
      addLatestYearStat(item),
    ].filter(Boolean),
  };
}

function buildKeywordUi(item, metadata) {
  return {
    subtitle: joinParts([
      metadata.articleCount !== undefined ? `${metadata.articleCount} related articles` : null,
      item.publicationYear ? `Latest ${item.publicationYear}` : null,
    ]),
    snippet: null,
    imageUrl: null,
    badges: [
      makeBadge('Keyword', item.title),
    ].filter(Boolean),
    stats: [
      makeStat('Articles', metadata.articleCount),
      makeStat('Citations', item.citationCount),
      addLatestYearStat(item),
    ].filter(Boolean),
  };
}

function buildTopicUi(item, metadata) {
  return {
    subtitle: joinParts([metadata.subjectCategoryName, metadata.subjectAreaName]),
    snippet: joinParts([
      metadata.articleCount !== undefined ? `${metadata.articleCount} related articles` : null,
      metadata.score !== undefined ? `Topic score ${metadata.score}` : null,
    ]),
    imageUrl: null,
    badges: [
      makeBadge('Subject category', metadata.subjectCategoryName),
      makeBadge('Subject area', metadata.subjectAreaName),
    ].filter(Boolean),
    stats: [
      makeStat('Articles', metadata.articleCount),
      makeStat('Topic score', metadata.score),
      makeStat('Citations', item.citationCount),
      addLatestYearStat(item),
    ].filter(Boolean),
  };
}

const UI_BUILDERS = {
  article: buildArticleUi,
  journal: buildJournalUi,
  author: buildAuthorUi,
  institution: buildInstitutionUi,
  keyword: buildKeywordUi,
  topic: buildTopicUi,
};

function enrichSearchItem(item, rank) {
  const metadata = item?.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  const uiConfig = SEARCH_TYPE_UI[item.type] || {
    label: item.type,
    icon: 'search',
    detailPath: (id) => `/search/${id}`,
  };
  const buildUi = UI_BUILDERS[item.type];
  const ui = buildUi ? buildUi(item, metadata) : {
    subtitle: null,
    snippet: truncateText(item.description),
    imageUrl: null,
    badges: [],
    stats: [],
  };

  return {
    ...item,
    rank,
    typeLabel: uiConfig.label,
    typeIcon: uiConfig.icon,
    subtitle: ui.subtitle,
    snippet: ui.snippet,
    imageUrl: ui.imageUrl,
    detailPath: uiConfig.detailPath(item.id),
    badges: ui.badges,
    stats: ui.stats,
    metadata,
  };
}

/**
 * Search articles, journals, authors and related research entities.
 *
 * @param {object} filters
 * @param {string} filters.q
 * @param {'all'|'article'|'journal'|'author'|'institution'|'keyword'|'topic'} filters.type
 * @param {string|number} [filters.project_id]
 * @param {number} filters.page
 * @param {number} filters.limit
 * @param {number} [filters.from_year]
 * @param {number} [filters.to_year]
 * @param {'relevance'|'year_desc'|'citations_desc'|'name_asc'} filters.sort
 * @returns {Promise<object>}
 */
export async function searchEntities(filters) {
  const qClean = String(filters.q || '').trim();
  const type = filters.type || 'all';
  const page = filters.page || 1;
  const limit = filters.limit || 10;
  const offset = (page - 1) * limit;
  const selectedTypes = type === 'all' ? SEARCH_TYPES : [type];
  const sort = filters.sort || 'relevance';

  const cacheKey = `search:entities:${type}:${filters.project_id || 'all'}:${page}:${limit}:${sort}:${qClean.toLowerCase()}:${filters.from_year || 'all'}:${filters.to_year || 'all'}`;

  try {
    const cached = await redisGet(cacheKey);
    if (cached) {
      logger.info(`[Redis] Search cache hit for key: ${cacheKey}`);
      return JSON.parse(cached);
    }
  } catch (err) {
    logger.warn('Failed to retrieve search results from Redis, fallback to DB:', err?.message || err);
  }

  try {
    let scope = null;
    if (filters.project_id) {
      scope = await getProjectScope(pool, filters.project_id);
      if (scope?.subjectCategoryIds?.length > 0) {
        const topicRes = await pool.query(
          'SELECT topic_id FROM "Topic" WHERE subject_category_id = ANY($1::bigint[])',
          [scope.subjectCategoryIds]
        );
        scope.inScopeTopicIds = topicRes.rows.map((r) => Number(r.topic_id));
      } else {
        scope.inScopeTopicIds = [];
      }
    }

    const params = [
      qClean.toLowerCase(),
      `${escapeLikePattern(qClean)}%`,
      `%${escapeLikePattern(qClean)}%`,
    ];

    const context = {
      exactIndex: 1,
      prefixIndex: 2,
      patternIndex: 3,
      scope,
      fromYear: filters.from_year,
      toYear: filters.to_year,
    };

    const orderBy = getOrderBy(sort);

    // 1 & 2. Phase 1 & 2: Meilisearch integration
    const { meiliClient } = await import('../config/meili.js');
    let useMeilisearch = false;
    try {
      const health = await meiliClient.health();
      if (health.status === 'available') useMeilisearch = true;
    } catch (e) {
      logger.warn('[Meilisearch] Not available, falling back to PostgreSQL search');
    }

    let rawCounts = {};
    let total = 0;
    let mergedResults = [];

    const traceId = Math.random().toString(36).substring(7);

    if (useMeilisearch) {
      console.time(`==> Phase 1 & 2: Meilisearch [${traceId}]`);
      try {
        const indexesResponse = await meiliClient.getRawIndexes();
        const indexList = Array.isArray(indexesResponse) ? indexesResponse : (indexesResponse.results || []);
        const availableUids = new Set(indexList.map(idx => idx.uid));
        
        const getIndexUid = (type) => `${type}s`;
        
        const validSelectedTypes = selectedTypes.filter(type => availableUids.has(getIndexUid(type)));
        if (validSelectedTypes.length === 0) {
           useMeilisearch = false;
           logger.info('[Meilisearch] No valid indexes available to query yet.');
        }

        if (useMeilisearch) {
          const queries = validSelectedTypes.map(type => {
          let filter = [];
          if (filters.from_year) filter.push(`publication_year >= ${filters.from_year}`);
          if (filters.to_year) filter.push(`publication_year <= ${filters.to_year}`);
          
          return {
            indexUid: getIndexUid(type),
            q: qClean,
            limit: offset + limit,
            filter: filter.length > 0 ? filter.join(' AND ') : undefined,
          };
        });

        const multiSearchRes = await meiliClient.multiSearch({ queries });
        
        multiSearchRes.results.forEach((res, index) => {
          const type = validSelectedTypes[index];
          const hitsCount = res.estimatedTotalHits || res.hits.length || 0;
          rawCounts[type] = hitsCount;
          total += hitsCount;
          
          if (res.hits) {
            res.hits.forEach(hit => {
              const entityId = hit.id || hit.article_id || hit.journal_id || hit.author_id || hit.institution_id || hit.keyword_id || hit.topic_id;
              mergedResults.push({
                entity_type: type,
                entity_id: String(entityId),
                title: hit.title || hit.display_name || '',
                description: hit.description || hit.abstract || null,
                publication_year: hit.publication_year ? Number(hit.publication_year) : null,
                citation_count: Number(hit.citation_count || hit.cited_by_count || 0),
                relevance: hit._rankingScore || 100
              });
            });
          }
        });
        }
        if (useMeilisearch) console.timeEnd(`==> Phase 1 & 2: Meilisearch [${traceId}]`);
      } catch (err) {
        logger.error('[Meilisearch] Search failed:', err);
        useMeilisearch = false;
      }
    }

    if (!useMeilisearch) {
      logger.warn('[Search] PostgreSQL fallback is disabled per configuration. Returning empty results.');
      selectedTypes.forEach(type => rawCounts[type] = 0);
    }

    console.time(`==> Phase 3: Global sort and slice [${traceId}]`);
    // 3. Global in-memory sort
    const compareNullsLast = (valA, valB, desc = true) => {
      if (valA === null && valB === null) return 0;
      if (valA === null) return 1;
      if (valB === null) return -1;
      if (valA === valB) return 0;
      return desc ? (valA > valB ? -1 : 1) : (valA < valB ? -1 : 1);
    };

    const compareStrings = (strA, strB) => {
      return String(strA || '').localeCompare(String(strB || ''));
    };

    mergedResults.sort((a, b) => {
      if (sort === 'year_desc') {
        const yearComp = compareNullsLast(a.publication_year, b.publication_year, true);
        if (yearComp !== 0) return yearComp;
        const relComp = compareNullsLast(a.relevance, b.relevance, true);
        if (relComp !== 0) return relComp;
        const citComp = compareNullsLast(a.citation_count, b.citation_count, true);
        if (citComp !== 0) return citComp;
        return compareStrings(a.title, b.title);
      } else if (sort === 'citations_desc') {
        const citComp = compareNullsLast(a.citation_count, b.citation_count, true);
        if (citComp !== 0) return citComp;
        const relComp = compareNullsLast(a.relevance, b.relevance, true);
        if (relComp !== 0) return relComp;
        const yearComp = compareNullsLast(a.publication_year, b.publication_year, true);
        if (yearComp !== 0) return yearComp;
        return compareStrings(a.title, b.title);
      } else if (sort === 'name_asc') {
        const titleComp = compareStrings(a.title, b.title);
        if (titleComp !== 0) return titleComp;
        const relComp = compareNullsLast(a.relevance, b.relevance, true);
        if (relComp !== 0) return relComp;
        return compareNullsLast(a.publication_year, b.publication_year, true);
      } else {
        const relComp = compareNullsLast(a.relevance, b.relevance, true);
        if (relComp !== 0) return relComp;
        const citComp = compareNullsLast(a.citation_count, b.citation_count, true);
        if (citComp !== 0) return citComp;
        const yearComp = compareNullsLast(a.publication_year, b.publication_year, true);
        if (yearComp !== 0) return yearComp;
        return compareStrings(a.title, b.title);
      }
    });

    const paginatedSlice = mergedResults.slice(offset, offset + limit);
    console.timeEnd(`==> Phase 3: Global sort and slice [${traceId}]`);

    // 4. Batch deferred hydration
    console.time(`==> Phase 4: Hydration total [${traceId}]`);
    const groupedIds = {};
    for (const item of paginatedSlice) {
      if (!groupedIds[item.entity_type]) {
        groupedIds[item.entity_type] = [];
      }
      groupedIds[item.entity_type].push(item.entity_id);
    }

    const hydrationPromises = Object.keys(groupedIds).map(async (entityType) => {
      const ids = groupedIds[entityType];
      if (ids.length === 0) return [];
      const buildQuery = BRANCH_BUILDERS[entityType];
      const typeParams = [];
      const sql = buildQuery(typeParams, context, 'hydrate', ids);
      try {
        const hydrateRes = await pool.query(sql, typeParams);
        return hydrateRes.rows;
      } catch (err) {
        logger.error(`Error hydrating details for ${entityType}:`, err);
        return [];
      }
    });

    const hydratedRowsList = await Promise.all(hydrationPromises);
    const hydratedRowsMap = {};
    for (const rows of hydratedRowsList) {
      for (const row of rows) {
        const key = `${row.entity_type}:${row.entity_id}`;
        hydratedRowsMap[key] = row;
      }
    }
    console.timeEnd(`==> Phase 4: Hydration total [${traceId}]`);

    const rawItems = paginatedSlice.map((sliceItem) => {
      const key = `${sliceItem.entity_type}:${sliceItem.entity_id}`;
      const hydrated = hydratedRowsMap[key];
      const metadata = hydrated?.metadata || {};
      return {
        id: sliceItem.entity_id,
        type: sliceItem.entity_type,
        title: sliceItem.title,
        description: sliceItem.description,
        publicationYear: sliceItem.publication_year,
        citationCount: sliceItem.citation_count,
        score: sliceItem.relevance,
        metadata,
      };
    });

    const response = {
      query: qClean,
      type,
      projectId: filters.project_id || null,
      page,
      limit,
      total,
      totalPages: total > 0 ? Math.ceil(total / limit) : 0,
      counts: normalizeCounts(rawCounts, selectedTypes),
      items: rawItems.map((item, index) => enrichSearchItem(item, offset + index + 1)),
    };

    try {
      await redisSet(cacheKey, JSON.stringify(response), 300);
    } catch (err) {
      logger.warn('Failed to cache search response in Redis:', err?.message || err);
    }

    return response;
  } catch (err) {
    throw err;
  }
}
