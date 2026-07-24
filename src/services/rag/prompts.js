import { SCHEMA_REGISTRY, BRIDGE_TABLES, JOIN_GRAPH } from '../infrastructure/db_schema_registry.js';

// ==========================================
// 1. ROUTER PROMPT (Compact & Compressed)
// ==========================================
export const buildRouterPrompt = (userQuestion) => `
Classify query intent for a scientific publication database. Output ONLY valid raw JSON text. No markdown formatting.

Routes:
- ARTICLE_SQL: counts, stats, publication year, DOI, citation count queries.
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
export const buildSqlPrompt = (userQuestion, routeDecision, scope) => {
    const requiredTables = routeDecision?.required_tables || null;
    const schemaInfo = buildSchemaInfoString(requiredTables);
    const primaryEntity = routeDecision?.primary_entity || "Article";

    const scopeDetails = scope ? `
SCOPE: Project ID ${scope.projectId}, Area "${scope.subjectAreaName}".
Placeholders: __PROJECT_SUBJECT_CATEGORIES__ and __PROJECT_KEYWORD_IDS__.
` : '';

    return `
You are a PostgreSQL text-to-sql generator. Obey primary entity "${primaryEntity}".
Return ONLY a valid JSON object: {"sql":"SELECT ...", "confidence":0.95}. Do NOT use markdown.

${schemaInfo}
${scopeDetails}

RULES:
1. Generate a single SELECT statement.
2. Root table in FROM clause must be "${primaryEntity}".
3. Use exact table names in double quotes: "Article", "Journal", "Volume", "Issue", "Author", "Publisher", "Subject_Category", "Journal_Ranking", "Topic", etc.
4. Soft-delete filter alias.is_deleted = false where applicable.
5. Limit to 20 rows unless aggregated.
6. Text matches use ILIKE '%term%'.

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
3. Format as a clean markdown list. Do not use Markdown tables.

User Question: ${userQuestion}
`.trim();
};
