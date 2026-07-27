import { SCHEMA_REGISTRY, BRIDGE_TABLES, JOIN_GRAPH } from '../infrastructure/db_schema_registry.js';

// ==========================================
// JOIN PATH HELPER (feeds AI the correct join clauses)
// ==========================================
const buildJoinPathsString = (requiredTables) => {
    if (!Array.isArray(requiredTables) || requiredTables.length < 2) return '';
    const paths = [];
    const seen = new Set();
    for (const t1 of requiredTables) {
        for (const t2 of requiredTables) {
            if (t1 === t2) continue;
            const key = `${t1},${t2}`;
            const reverseKey = `${t2},${t1}`;
            if (seen.has(key) || seen.has(reverseKey)) continue;
            if (JOIN_GRAPH[key]) {
                paths.push(`${key}: ${JOIN_GRAPH[key].trim()}`);
                seen.add(key);
            } else if (JOIN_GRAPH[reverseKey]) {
                paths.push(`${reverseKey}: ${JOIN_GRAPH[reverseKey].trim()}`);
                seen.add(reverseKey);
            }
        }
    }
    return paths.length > 0 ? `\nJOIN PATHS (use exactly):\n${paths.join('\n')}\n` : '';
};

// ==========================================
// 1. ROUTER PROMPT (Compact & Compressed)
// ==========================================
export const buildRouterPrompt = (userQuestion) => `
Classify query intent for a scientific publication database. Output ONLY valid raw JSON text. No markdown formatting.

Available database tables (choose ONLY from this list for "required_tables" array):
- "Article" (articles, publications, citations, publication_year)
- "Journal" (journals, publisher, country, region)
- "Publisher" (publishers)
- "Author" (authors, works_count, cited_by_count, h_index)
- "Institution" (institutions, universities)
- "Subject_Area" (subject areas, fields)
- "Subject_Category" (subject categories, disciplines)
- "Topic" (topics)
- "Sub_Topic" (subtopics)
- "Keyword" (keywords)
- "Journal_Ranking" (rankings, quartiles, metrics)
- "Ranking_Metric" (metric types, codes)
- "Volume" (volumes)
- "Issue" (issues)
- "Zone" (geographic regions, countries, zones, khu vực, quốc gia)

Routes:
- GREETING_INTRO: greetings, small talk, or questions about the assistant/system identity, purpose, capabilities, or how to use it ("bạn là ai", "hệ thống này là gì", "làm được gì", "who are you", "what can you do").
- STATS_SQL: aggregation/statistics questions asking for counts, sums, averages, distributions, breakdowns or grouping ("thống kê", "phân tích số liệu", "phân bố", "bao nhiêu", "số lượng theo", "distribution", "how many ... by"). Requires GROUP BY / COUNT / SUM / AVG.
- ARTICLE_SQL: list or look up SPECIFIC articles by title/DOI/year (returns a list of individual papers). Do NOT use for aggregate statistics.
- VECTOR_RAG: semantic search, discovery by topic/concept, "bài báo về...", vague research intent.
- JOURNAL_SQL: journal metadata, list journals, publishers.
- RANKING_SQL: Q1-Q4 quartiles, SJR, H-index, rankings by year.
- AUTHOR_SQL: author works, citations, H-index.
- PUBLISHER_SQL: publisher information.
- SUBJECT_SQL: subject areas/categories.
- TOPIC_SQL: topics/sub-topics.
- KEYWORD_SQL: keywords.
- INSTITUTION_SQL: author institutions.
- CLARIFY: ambiguous request.

JSON Output Schema:
{"route":"ROUTE_NAME","primary_entity":"EntityName","intent_type":"desc","required_tables":["Table1"],"reason":"exp"}

Rules:
1. "required_tables" MUST only contain exact table names from the "Available database tables" list above. Never output arbitrary table names (e.g. do not output "publication", "location", "area").
2. If the user asks for numbers/statistics/distribution/breakdown, prefer STATS_SQL over ARTICLE_SQL.
3. If the query asks for countries or regions (quốc gia, khu vực), include both "Zone" and "Journal" in the required_tables.
4. If the query asks for articles, include "Article" in required_tables.

Question: ${userQuestion}
`.trim();

// ==========================================
// 2. COMPACT SCHEMA BUILDER (Dynamic Filtering)
// ==========================================
export const buildSchemaInfoString = (requiredTables = null) => {
    const lines = [];
    const filterActive = Array.isArray(requiredTables) && requiredTables.length > 0;
    const reqSet = filterActive ? new Set(requiredTables.map(t => String(t).toLowerCase())) : null;

    lines.push("SCHEMA:");
    for (const [entity, meta] of Object.entries(SCHEMA_REGISTRY)) {
        if (reqSet && !reqSet.has(entity.toLowerCase()) && !reqSet.has(meta.table.toLowerCase())) {
            continue;
        }
        const cols = meta.columns.join(", ");
        const softDelete = meta.soft_delete ? ` | filter: ${meta.soft_delete}` : '';
        lines.push(`- "${meta.table}" (${meta.alias}): [${cols}]${softDelete}`);
    }

    lines.push("\nBRIDGES:");
    for (const [bTable, meta] of Object.entries(BRIDGE_TABLES)) {
        if (reqSet && !reqSet.has(bTable.toLowerCase()) && !reqSet.has(meta.table.toLowerCase())) {
            continue;
        }
        lines.push(`- "${meta.table}" (${meta.alias})`);
    }

    return lines.join("\n");
};

// ==========================================
// 3. SQL GENERATOR PROMPT (Modular & Dynamic)
// ==========================================
export const buildSqlPrompt = (userQuestion, routeDecision, scope, repairContext = null) => {
    const requiredTables = routeDecision?.required_tables || null;
    const schemaInfo = buildSchemaInfoString(requiredTables);
    const joinPaths = buildJoinPathsString(requiredTables);
    const primaryEntity = routeDecision?.primary_entity || "Article";

    const scopeDetails = scope ? `
SCOPE: Project ID ${scope.projectId}, Area "${scope.subjectAreaName}".
Placeholders: __PROJECT_SUBJECT_CATEGORIES__ and __PROJECT_KEYWORD_IDS__.
` : '';

    const repairBlock = repairContext ? `
⚠️ PREVIOUS ATTEMPT FAILED. Fix the error and try again.
Previous SQL:
${repairContext.sql}
Error: ${repairContext.error}
HINT: Only use columns listed in SCHEMA above. To join Article with Subject_Category/Subject_Area/region/country you MUST go through Topic (Article.primary_topic = Topic.topic_id, then Topic.subject_category_id) OR through Issue→Volume→Journal (Journal.country, Journal.region).
` : '';

    return `
You are a PostgreSQL text-to-sql generator. Obey primary entity "${primaryEntity}".
Return ONLY a valid JSON object: {"sql":"SELECT ...", "confidence":0.95}. Do NOT use markdown.

${schemaInfo}${joinPaths}${scopeDetails}${repairBlock}

RULES:
1. Generate a single SELECT statement.
2. For statistics like "phân bố theo khu vực / country / region": the FROM must be "Article" AS a, and JOIN through Issue→Volume→Journal→Zone, then GROUP BY z.name.
3. Use exact table names in double quotes: "Article", "Journal", "Volume", "Issue", "Author", "Publisher", "Subject_Category", "Journal_Ranking", "Topic", "Zone".
4. Use EXACT column names from SCHEMA. Common primary keys: a.article_id (NOT a.id), j.journal_id, z.zone_id, i.issue_id, v.volume_id. Do not invent "a.id" or "j.id".
5. NEVER reference "project_id" on any table — it does not exist. Project scoping is done via placeholders __PROJECT_SUBJECT_CATEGORIES__ and __PROJECT_KEYWORD_IDS__ in the scoped filter.
6. Every alias in WHERE/GROUP BY/ORDER BY MUST also appear in FROM or JOIN. Never reference alias "j" in WHERE unless "Journal" was joined.
7. Zone/Region/Country relationship: "Journal".region = "Zone".zone_id (use LEFT JOIN "Zone" AS z ON z.zone_id = j.region).
8. Soft-delete filter alias.is_deleted = false where the column exists on that table.
9. Text matches use ILIKE '%term%'.
10. For statistics/counts/distribution/breakdown: use aggregation COUNT(DISTINCT a.article_id) with GROUP BY the dimension (year, z.name, quartile), ORDER BY the aggregate DESC, LIMIT 50.
11. Otherwise (listing specific records), limit to 20 rows.
12. ⚠️ CRITICAL: NEVER invent columns. Only use columns defined in SCHEMA above.
13. "Article" has NO direct subject_category_id, country, region, or journal_id. To filter/group by subject_category use JOIN "Topic" ON "Topic".topic_id = a.primary_topic. To filter/group by country/region use JOIN "Issue" → "Volume" → "Journal" → "Zone".

EXAMPLE (distribution of articles by world region):
{"sql":"SELECT z.name AS region_name, COUNT(DISTINCT a.article_id) AS article_count FROM \\"Article\\" AS a LEFT JOIN \\"Issue\\" AS i ON i.issue_id = a.issue_id LEFT JOIN \\"Volume\\" AS v ON v.volume_id = i.volume_id LEFT JOIN \\"Journal\\" AS j ON j.journal_id = v.journal_id LEFT JOIN \\"Zone\\" AS z ON z.zone_id = j.region WHERE COALESCE(a.is_deleted, false) = false AND z.name IS NOT NULL GROUP BY z.name ORDER BY article_count DESC LIMIT 50","confidence":0.95}

Question: ${userQuestion}
`.trim();
};

// ==========================================
// 4. FINAL ANSWER PROMPT (Language Adaptive)
// ==========================================
export const buildFinalAnswerPrompt = (userQuestion, routeDecision, rows, scope) => {
    const contextData = rows && rows.length > 0 ? JSON.stringify(rows) : "[]";
    const projectContext = scope ? `Context: Project ${scope.projectId} ("${scope.subjectAreaName}").` : '';

    return `
Answer the user question using ONLY the provided database rows.
${projectContext}

Rows: ${contextData}

RULES:
1. Respond 100% in the language of the User Question (Vietnamese / English / Japanese).
2. Translate field labels cleanly to match the output language.
3. If the rows are aggregated statistics (contain counts/totals/grouped values), present them as a clean Markdown TABLE and add one short insight sentence (e.g. which group is highest). Otherwise, format as a clean markdown list.
4. Be concise. Do not repeat the question or add filler.

User Question: ${userQuestion}
`.trim();
};
