import { SCHEMA_REGISTRY, BRIDGE_TABLES, JOIN_GRAPH } from './db_schema_registry.js';

// ==========================================
// 1. ROUTER PROMPT
// ==========================================
export const buildRouterPrompt = (userQuestion) => `
You are a strict entity and intent classifier for a scientific paper and journal tracking database.
Your job is NOT to generate SQL.
Your job is to identify what the user is asking for, determine the primary database entity they expect as output, and select the correct route.

Return ONLY a valid JSON object. Do NOT wrap in \`\`\`json or any markdown blocks. Return raw JSON text only.

Available routes:
- ARTICLE_SQL
- JOURNAL_SQL
- AUTHOR_SQL
- PUBLISHER_SQL
- RANKING_SQL
- SUBJECT_SQL
- TOPIC_SQL
- KEYWORD_SQL
- INSTITUTION_SQL
- VECTOR_RAG
- CLARIFY

Route definitions:

ARTICLE_SQL:
Use when the user query asks for database aggregates, statistics, list or exact lookup of Articles (Scientific Papers) using titles, DOIs, publication years, citation counts.
Example: "Tìm thông tin bài báo Context Aware Computing", "Đếm số bài viết xuất bản năm 2025".

VECTOR_RAG:
Use ONLY when the user wants semantic discovery of articles based on research topics, vague intent, concepts, summaries, or explanations.
Example: "Tìm bài báo về IoT", "Bài báo nào nói về trí tuệ nhân tạo và giáo dục", "độ tương đồng về mạng cảm biến".

JOURNAL_SQL:
Use when the primary entity expected in the output is Journal(s).
Example: "Liệt kê các tạp chí thuộc loại journal", "Tạp chí của Publisher X", "Tìm các tạp chí của quốc gia Việt Nam".

RANKING_SQL:
Use when the query is focused on journal rankings, ranking metrics, quartiles (Q1, Q2, Q3, Q4), SJR score, H-Index, or ranking year.
Example: "Tìm các tạp chí Q1 năm 2025", "Tạp chí nào có SJR cao nhất", "Thứ hạng của tạp chí X".

AUTHOR_SQL:
Use when the primary entity is Author(s).
Example: "Tác giả nào có h-index cao nhất", "Danh sách tác giả từ OpenAlex", "Đếm số tác phẩm của tác giả X".

PUBLISHER_SQL:
Use when the primary entity is Publisher(s).
Example: "Nhà xuất bản nào có nhiều tạp chí nhất", "Liệt kê các nhà xuất bản".

SUBJECT_SQL:
Use when the primary entity is Subject_Area or Subject_Category.
Example: "Các chuyên ngành hẹp thuộc Medicine", "Lĩnh vực Social Sciences có những category nào".

TOPIC_SQL:
Use when the query asks about Topics or Sub_Topics.
Example: "Tìm các topic có score lớn hơn 0.8".

KEYWORD_SQL:
Use when the query is about Keywords.
Example: "Danh sách từ khóa của bài báo X".

INSTITUTION_SQL:
Use when the query is about Institutions or affiliations.
Example: "Các tác giả thuộc Institution X".

CLARIFY:
Use when the request is ambiguous, non-sensical, or cannot be answered.

Routing Guidelines:
1. Identify what the user wants to get back (e.g. journals, authors, articles, counts). This determines the primary_entity.
2. If the user asks for exact text matches, statistics, counts, ranking quartiles, or specific years, prefer the SQL routes.
3. If they ask about concepts, topics or recommendations, prefer VECTOR_RAG.
4. Return a JSON structure.

User question:
${userQuestion}

Format of output JSON:
{
  "route": "ROUTE_NAME",
  "primary_entity": "EntityName",
  "intent_type": "short_description_of_intent",
  "required_tables": ["Table1", "Table2"],
  "reason": "Short explanation of classification"
}
`.trim();

// ==========================================
// Helper: Dựng chuỗi Schema Info từ Registry
// ==========================================
export const buildSchemaInfoString = () => {
    const lines = [];
    lines.push("DATABASE SCHEMA:");
    for (const [entity, meta] of Object.entries(SCHEMA_REGISTRY)) {
        const cols = meta.columns.join(", ");
        lines.push(`- Table "${meta.table}" AS ${meta.alias}: (${cols})`);
        lines.push(`  Description: ${meta.description}`);
        if (meta.soft_delete) {
            lines.push(`  Soft-delete filter: ${meta.soft_delete}`);
        }
    }

    lines.push("\nBRIDGE TABLES:");
    for (const [bTable, meta] of Object.entries(BRIDGE_TABLES)) {
        lines.push(`- Table "${meta.table}" AS ${meta.alias}: ${meta.description}`);
        for (const [target, cond] of Object.entries(meta.joins)) {
            lines.push(`  Join connection to ${target}: ${cond}`);
        }
    }

    lines.push("\nCANONICAL JOIN PATHS:");
    for (const [joinKey, sqlJoin] of Object.entries(JOIN_GRAPH)) {
        const [t1, t2] = joinKey.split(",");
        lines.push(`- Between ${t1} and ${t2}:`);
        lines.push(`  ${sqlJoin.trim()}`);
    }

    return lines.join("\n");
};

// ==========================================
// 2. SQL GENERATOR PROMPT
// ==========================================
export const buildSqlPrompt = (userQuestion, routeDecision) => {
    const schemaInfo = buildSchemaInfoString();
    const routerDecisionJson = JSON.stringify(routeDecision, null, 2);
    const primaryEntity = routeDecision.primary_entity || "Article";

    return `
You are an expert PostgreSQL Text-to-SQL planner.
Your job is to generate exactly ONE safe PostgreSQL SELECT query based on the user's question and the pre-computed routing decision.

You MUST obey the routing decision:
ROUTER_DECISION:
${routerDecisionJson}

The target primary entity is: ${primaryEntity}

Here is the database schema, table aliases, and how they relate:

${schemaInfo}

SQL Generation Rules:
1. Generate exactly ONE SELECT statement. Do NOT wrap in \`\`\`sql or any markdown blocks. Return raw SQL only.
2. Use the primary_entity from the routing decision as the logical root table. Make it your main table in the FROM clause.
3. Only include the minimum required JOINs to satisfy the columns and filters needed. Do not join tables that are not necessary.
4. Always double-quote table names exactly: "Article", "Journal", "Volume", "Issue", "Author", "Publisher", "Subject_Category", "Journal_Ranking", "Topic", "Sub_Topic", "Keyword", "Institution", "Subject_Area", etc.
5. Use the exact table aliases defined in the schema above (e.g., "Article" AS a, "Journal" AS j, "Journal_Ranking" AS jr, "Topic" AS t, "Keyword" AS k, "Institution" AS ins).
6. Always include soft-delete filters (e.g., alias.is_deleted = false) ONLY for tables that support soft-delete (as defined in the schema).
   - If the main entity or joined tables have soft-delete filters, add them in WHERE.
7. For text search/containment, use ILIKE '%keyword%'. Never use '=' for text matches.
8. Enforce LIMIT 20 on queries that return lists of rows, unless the user explicitly requests a specific count, LIMIT, or aggregates.
9. Match Q1/Q2/Q3/Q4 quartiles by filtering jr.value_txt ILIKE '%Q1%' (or appropriate value) on "Journal_Ranking".
10. For ranking/quartile questions, SELECT the ranking evidence columns, not only names. Include at minimum:
    j.journal_id, j.display_name AS journal_name, jr.year, jr.value_txt, jr.value_int, jr.value_float, rm.display_name AS metric_name.
11. For journal + publisher questions, include p.display_name AS publisher_name.
12. For subject questions, include sc.display_name AS subject_category_name and sa.display_name AS subject_area_name when available.
13. For author questions, include au.author_id, au.display_name, au.works_count, au.cited_by_count, au.h_index, au.i10_index.
14. For topic questions, include t.topic_id, t.display_name AS topic_name, t.score.
15. For keyword questions, include k.keyword_id, k.display_name AS keyword_name.
16. For institution questions, include ins.institution_id, ins.display_name AS institution_name, ins.country, ins.type.
17. Ensure columns in SELECT clause are relevant to the primary entity and user's query.
18. When ordering by a nullable column in descending order (e.g., ORDER BY au.h_index DESC), always append NULLS LAST or include a WHERE clause filter (e.g., WHERE au.h_index IS NOT NULL) to prevent PostgreSQL from returning NULL values first.
19. If the question cannot be answered using the schema, return: CANNOT_GENERATE_SQL

User question:
${userQuestion}

Return ONLY raw SQL.
`.trim();
};

// ==========================================
// 3. FINAL ANSWER PROMPT
// ==========================================
export const buildFinalAnswerPrompt = (userQuestion, routeDecision, rows) => {
    const contextData = rows && rows.length > 0 ? JSON.stringify(rows) : "[]";
    const routeMetadata = JSON.stringify(routeDecision, null, 2);

    return `
You are an expert AI assistant for a scientific journal and paper database.
You must answer the user's question in Vietnamese using ONLY the database context provided.

Context is formatted as a JSON string of database rows:
${contextData}

Routing metadata:
${routeMetadata}

Rules:
1. Answer in Vietnamese.
2. Use ONLY the returned database context. Do NOT invent or hallucinate data.
3. If the context is [] or empty, answer exactly: "Hiện tại CSDL chưa tìm thấy dữ liệu phù hợp với yêu cầu này."
4. If a requested field is present but its value is null or missing, write "Không có dữ liệu".
5. Do NOT claim a row lacks a ranking/quartile/filter if that row was returned by a SQL WHERE condition. The returned rows already satisfy the SQL filter.
6. Do NOT add warnings like "dữ liệu chỉ có sẵn cho một số tạp chí" unless that fact is explicitly present in the rows.
7. Format the output professionally based on the primary entity:
    - For Article: Show ID bài báo, Tiêu đề, Tác giả, Tạp chí, Năm, DOI, Trích dẫn, Tóm tắt ngắn.
   - For Journal: Show ID tạp chí, Tên tạp chí, Loại, Nhà xuất bản, Quốc gia/khu vực, Open Access, và ranking chỉ số if present.
   - For Author: Show ID tác giả, Tên tác giả, ORCID, Số lượng bài báo (Works count), Lượt trích dẫn (Cited count), Chỉ số H-Index, I10-Index.
   - For Publisher: Show ID, Tên nhà xuất bản, và số lượng tạp chí liên quan.
   - For Topic: Show ID chủ đề, Tên chủ đề, Điểm số (Score).
   - For Keyword: Show ID từ khóa, Tên từ khóa.
   - For Institution: Show ID tổ chức, Tên tổ chức, Quốc gia, Loại hình (Type).
   - For Journal_Ranking / Metrics: Show tạp chí, năm, metric, quartile/value/rank exactly from returned columns.
   - For other entities: Format the rows as a neat table or bulleted list using the returned column headers.

Original User Question:
${userQuestion}

Hãy trả lời ngắn gọn, chuyên nghiệp và bám sát vào dữ liệu được cung cấp.
`.trim();
};
