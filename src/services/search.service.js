import pool from '../config/database.js';
import { getProjectScope } from './forecast.service.js';

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
  return `COALESCE(${field}::text, '') ILIKE $${patternIndex} ESCAPE '\\'`;
}

function textStartsWith(field, prefixIndex) {
  return `COALESCE(${field}::text, '') ILIKE $${prefixIndex} ESCAPE '\\'`;
}

function textExact(field, exactIndex) {
  return `LOWER(COALESCE(${field}::text, '')) = $${exactIndex}`;
}

function buildSearchCondition(fields, patternIndex) {
  return `(${fields.map((field) => textMatches(field, patternIndex)).join(' OR ')})`;
}

function buildArticleScopeCondition(params, scope, articleAlias = 'a') {
  const conditions = [];

  if (scope?.subjectCategoryIds?.length > 0) {
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

function buildArticleBranch(params, context) {
  const { exactIndex, prefixIndex, patternIndex, scope, fromYear, toYear } = context;
  const filters = buildArticleFilters(params, {
    scope,
    fromYear,
    toYear,
    articleAlias: 'a',
    includeSoftDelete: true,
  });

  filters.push(`
    (
      ${buildSearchCondition(['a.title', 'a.abstract', 'a.doi', 'j.display_name'], patternIndex)}
      OR EXISTS (
        SELECT 1
        FROM "Author_Article" aa_search
        JOIN "Author" au_search ON au_search.author_id = aa_search.author_id
        WHERE aa_search.article_id = a.article_id
          AND COALESCE(au_search.is_deleted, false) = false
          AND ${textMatches('au_search.display_name', patternIndex)}
      )
      OR EXISTS (
        SELECT 1
        FROM "Keyword_Article" ka_search
        JOIN "Keyword" k_search ON k_search.keyword_id = ka_search.keyword_id
        WHERE ka_search.article_id = a.article_id
          AND ${textMatches('k_search.display_name', patternIndex)}
      )
    )
  `);

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
      CASE
        WHEN ${textExact('a.title', exactIndex)} THEN 100
        WHEN ${textStartsWith('a.title', prefixIndex)} THEN 85
        WHEN ${textMatches('a.title', patternIndex)} THEN 70
        WHEN ${textMatches('a.doi', patternIndex)} THEN 65
        WHEN ${textMatches('j.display_name', patternIndex)}
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
    LEFT JOIN "Issue" iss ON iss.issue_id = a.issue_id
    LEFT JOIN "Volume" v ON v.volume_id = iss.volume_id
    LEFT JOIN "Journal" j ON j.journal_id = v.journal_id
    WHERE ${filters.join('\n      AND ')}
  `;
}

function buildJournalBranch(params, context) {
  const { exactIndex, prefixIndex, patternIndex, scope, fromYear, toYear } = context;
  const filters = [
    'COALESCE(j.is_deleted, false) = false',
    buildSearchCondition(['j.display_name', 'j.issn', 'j.country', 'j.region', 'j.type', 'p.display_name'], patternIndex),
    ...buildArticleFilters(params, { scope, fromYear, toYear, articleAlias: 'a' }),
  ];

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
    LEFT JOIN "Volume" v ON v.journal_id = j.journal_id AND COALESCE(v.is_deleted, false) = false
    LEFT JOIN "Issue" iss ON iss.volume_id = v.volume_id AND COALESCE(iss.is_deleted, false) = false
    LEFT JOIN "Article" a ON a.issue_id = iss.issue_id AND COALESCE(a.is_deleted, false) = false
    WHERE ${filters.join('\n      AND ')}
    GROUP BY j.journal_id, j.source_id, j.display_name, j.issn, j.country, j.region, j.type, j.is_open_access, j.is_oa_diamond, p.publisher_id, p.display_name, p.image_url
  `;
}

function buildAuthorBranch(params, context) {
  const { exactIndex, prefixIndex, patternIndex, scope, fromYear, toYear } = context;
  const filters = [
    'COALESCE(au.is_deleted, false) = false',
    buildSearchCondition(['au.display_name', 'au.orcid', 'au.openalex_id'], patternIndex),
    ...buildArticleFilters(params, { scope, fromYear, toYear, articleAlias: 'a' }),
  ];

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
      CASE
        WHEN ${textExact('au.display_name', exactIndex)} THEN 100
        WHEN ${textStartsWith('au.display_name', prefixIndex)} THEN 85
        WHEN ${textMatches('au.display_name', patternIndex)} THEN 70
        WHEN ${textMatches('au.orcid', patternIndex)} THEN 60
        ELSE 30
      END::int AS relevance
    FROM "Author" au
    LEFT JOIN "Author_Article" aa ON aa.author_id = au.author_id
    LEFT JOIN "Article" a ON a.article_id = aa.article_id AND COALESCE(a.is_deleted, false) = false
    WHERE ${filters.join('\n      AND ')}
    GROUP BY au.author_id, au.display_name, au.orcid, au.openalex_id, au.url_image, au.works_count, au.cited_by_count, au.h_index, au.i10_index, au.last_known_institution, au.last_known_institution_id
  `;
}

function buildInstitutionBranch(params, context) {
  const { exactIndex, prefixIndex, patternIndex, scope, fromYear, toYear } = context;
  const filters = [
    'COALESCE(ins.is_deleted, false) = false',
    buildSearchCondition(['ins.display_name', 'ins.openalex_id', 'ins.country_code', 'ins.type'], patternIndex),
    ...buildArticleFilters(params, { scope, fromYear, toYear, articleAlias: 'a' }),
  ];

  return `
    SELECT
      'institution'::text AS entity_type,
      ins.institution_id::text AS entity_id,
      ins.display_name::text AS title,
      ins.country_code::text AS description,
      MAX(a.publication_year)::int AS publication_year,
      COALESCE(SUM(DISTINCT COALESCE(a.citation_count, 0)), 0)::bigint AS citation_count,
      jsonb_build_object(
        'openalexId', ins.openalex_id,
        'countryCode', ins.country_code,
        'institutionType', ins.type,
        'authorCount', COUNT(DISTINCT ia.author_id),
        'articleCount', COUNT(DISTINCT a.article_id)
      ) AS metadata,
      CASE
        WHEN ${textExact('ins.display_name', exactIndex)} THEN 100
        WHEN ${textStartsWith('ins.display_name', prefixIndex)} THEN 85
        WHEN ${textMatches('ins.display_name', patternIndex)} THEN 70
        WHEN ${textMatches('ins.openalex_id', patternIndex)} THEN 55
        WHEN ${textMatches('ins.country_code', patternIndex)} THEN 45
        ELSE 30
      END::int AS relevance
    FROM "Institution" ins
    LEFT JOIN "Institution_Author" ia ON ia.institution_id = ins.institution_id
    LEFT JOIN "Author_Article" aa ON aa.author_id = ia.author_id
    LEFT JOIN "Article" a ON a.article_id = aa.article_id AND COALESCE(a.is_deleted, false) = false
    WHERE ${filters.join('\n      AND ')}
    GROUP BY ins.institution_id, ins.openalex_id, ins.display_name, ins.country_code, ins.type
  `;
}

function buildKeywordBranch(params, context) {
  const { exactIndex, prefixIndex, patternIndex, scope, fromYear, toYear } = context;
  const filters = [
    buildSearchCondition(['k.display_name'], patternIndex),
    ...buildArticleFilters(params, { scope, fromYear, toYear, articleAlias: 'a' }),
  ];

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
      CASE
        WHEN ${textExact('k.display_name', exactIndex)} THEN 100
        WHEN ${textStartsWith('k.display_name', prefixIndex)} THEN 85
        WHEN ${textMatches('k.display_name', patternIndex)} THEN 70
        ELSE 30
      END::int AS relevance
    FROM "Keyword" k
    LEFT JOIN "Keyword_Article" ka ON ka.keyword_id = k.keyword_id
    LEFT JOIN "Article" a ON a.article_id = ka.article_id AND COALESCE(a.is_deleted, false) = false
    WHERE ${filters.join('\n      AND ')}
    GROUP BY k.keyword_id, k.display_name
  `;
}

function buildTopicBranch(params, context) {
  const { exactIndex, prefixIndex, patternIndex, scope, fromYear, toYear } = context;
  const filters = [
    'COALESCE(t.is_deleted, false) = false',
    buildSearchCondition(['t.display_name', 'sc.display_name', 'sa.display_name'], patternIndex),
    ...buildArticleFilters(params, { scope, fromYear, toYear, articleAlias: 'a' }),
  ];

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
    LEFT JOIN "Article" a ON COALESCE(a.is_deleted, false) = false
      AND (
        a.primary_topic = t.topic_id
        OR EXISTS (
          SELECT 1
          FROM "Sub_Topic" st
          WHERE st.article_id = a.article_id
            AND st.topic_id = t.topic_id
        )
      )
    WHERE ${filters.join('\n      AND ')}
    GROUP BY t.topic_id, t.display_name, t.score, sc.subject_category_id, sc.display_name, sa.subject_area_id, sa.display_name
  `;
}

const BRANCH_BUILDERS = {
  article: buildArticleBranch,
  journal: buildJournalBranch,
  author: buildAuthorBranch,
  institution: buildInstitutionBranch,
  keyword: buildKeywordBranch,
  topic: buildTopicBranch,
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

  const client = await pool.connect();

  try {
    let scope = null;
    if (filters.project_id) {
      scope = await getProjectScope(client, filters.project_id);
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

    const branches = selectedTypes.map((selectedType) => {
      const buildBranch = BRANCH_BUILDERS[selectedType];
      return buildBranch(params, context);
    });

    params.push(limit);
    const limitIndex = params.length;
    params.push(offset);
    const offsetIndex = params.length;

    const orderBy = getOrderBy(filters.sort);
    const sql = `
      WITH search_results AS (
        ${branches.join('\n        UNION ALL\n')}
      ),
      counts AS (
        SELECT entity_type, COUNT(*)::int AS count
        FROM search_results
        GROUP BY entity_type
      ),
      paged AS (
        SELECT
          sr.*,
          ROW_NUMBER() OVER (ORDER BY ${orderBy}) AS row_number
        FROM search_results sr
        ORDER BY ${orderBy}
        LIMIT $${limitIndex} OFFSET $${offsetIndex}
      )
      SELECT
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', entity_id,
              'type', entity_type,
              'title', title,
              'description', description,
              'publicationYear', publication_year,
              'citationCount', citation_count,
              'score', relevance,
              'metadata', metadata
            )
            ORDER BY row_number
          )
          FROM paged
        ), '[]'::jsonb) AS items,
        COALESCE((
          SELECT jsonb_object_agg(entity_type, count)
          FROM counts
        ), '{}'::jsonb) AS counts,
        COALESCE((
          SELECT SUM(count)::int
          FROM counts
        ), 0) AS total
    `;

    const result = await client.query(sql, params);
    const row = result.rows[0] || {};
    const total = Number(row.total || 0);
    const rawItems = Array.isArray(row.items) ? row.items : [];

    return {
      query: qClean,
      type,
      projectId: filters.project_id || null,
      page,
      limit,
      total,
      totalPages: total > 0 ? Math.ceil(total / limit) : 0,
      counts: normalizeCounts(row.counts, selectedTypes),
      items: rawItems.map((item, index) => enrichSearchItem(item, offset + index + 1)),
    };
  } finally {
    client.release();
  }
}
