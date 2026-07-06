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
Use ONLY when the user query asks for structured database operations such as counts, aggregates, filters by year, DOI, citation counts, publication metadata, or exact deterministic metadata lookup.
Example: "Đếm số bài viết xuất bản năm 2025", "Bài báo DOI 10.xxxx có thông tin gì", "Liệt kê bài báo năm 2024 có citation cao nhất".

VECTOR_RAG:
Use when the user wants to find/discover articles by topic, concept, semantic meaning, title text, abstract content, summaries, recommendations, or vague research intent.
This includes common Vietnamese queries like "tìm bài báo về...", "tìm thông tin bài báo ...", "bài báo nào nói về...", "bài báo liên quan đến...", or a quoted article title without DOI.
Example: "Tìm bài báo về IoT", "Tìm thông tin bài báo Cleavage of Structural Proteins during the Assembly of the Head of Bacteriophage T4", "Bài báo nào nói về trí tuệ nhân tạo và giáo dục", "độ tương đồng về mạng cảm biến".

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
2. If the user asks for statistics, counts, ranking quartiles, explicit years, DOI lookup, or deterministic metadata filters, prefer the SQL routes.
3. If the user asks to find articles by topic, concept, title text, abstract meaning, recommendation, similarity, or "tìm thông tin bài báo ..." without DOI, route MUST be VECTOR_RAG.
4. Do NOT choose ARTICLE_SQL only because the query contains "bài báo", "article", or a quoted article title. Those are usually semantic retrieval requests and should use VECTOR_RAG.
5. required_tables MUST contain only real table names from this database. NEVER output invented tables such as "Article_Topic", "Vector_Index", "Project_Info", "project_info".
6. Return a JSON structure.

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
export const buildSqlPrompt = (userQuestion, routeDecision, scope) => {
    const schemaInfo = buildSchemaInfoString();
    const routerDecisionJson = JSON.stringify(routeDecision, null, 2);
    const primaryEntity = routeDecision.primary_entity || "Article";

    const scopeDetails = scope ? `
PROJECT SCOPE CONSTRAINTS:
- Project ID: ${scope.projectId}
- Target Subject Area: "${scope.subjectAreaName}" (ID: ${scope.subjectAreaId})
- Allowed Keywords: [${scope.keywordNames.map(k => `"${k}"`).join(', ')}]

CRITICAL DATABASE RULES:
- There is NO table named "Project_Info" or "project_info".
- Do NOT use columns like a.project_id because "Article" does NOT have a project_id column.
- Do NOT invent any table or column not listed in the schema.
- To enforce project scope, always join or include "Article" AS a and filter using Topic/Sub_Topic/Keyword_Article only.

How to apply the project scope filter:
1. Always JOIN or include the "Article" table (alias a) in your query.
2. In the WHERE clause, you MUST append a filter to match the project's subject categories OR keywords using the exact placeholders below:
   - For subject categories:
     (
       EXISTS (
         SELECT 1 FROM "Topic" AS primary_topic
         WHERE primary_topic.topic_id = a.primary_topic
           AND primary_topic.subject_category_id = ANY(__PROJECT_SUBJECT_CATEGORIES__)
       )
       OR EXISTS (
         SELECT 1 FROM "Sub_Topic" AS st
         JOIN "Topic" AS sub_topic ON st.topic_id = sub_topic.topic_id
         WHERE st.article_id = a.article_id
           AND sub_topic.subject_category_id = ANY(__PROJECT_SUBJECT_CATEGORIES__)
       )
     )
   - For keywords (if keywords exist):
     EXISTS (
       SELECT 1 FROM "Keyword_Article" AS ka
       WHERE ka.article_id = a.article_id
         AND ka.keyword_id = ANY(__PROJECT_KEYWORD_IDS__)
     )
   Combine them with OR if both exist: ((subject category filter) OR (keyword filter)).
   Use the exact placeholder tokens: __PROJECT_SUBJECT_CATEGORIES__ and __PROJECT_KEYWORD_IDS__. Do NOT change them.
3. For non-Article entities:
   - If querying "Journal" (j), join to "Article" (a) via:
     JOIN "Volume" AS v ON v.journal_id = j.journal_id
     JOIN "Issue" AS i ON i.volume_id = v.volume_id
     JOIN "Article" AS a ON a.issue_id = i.issue_id
   - If querying "Author" (au), join to "Article" (a) via:
     JOIN "Author_Article" AS aa ON aa.author_id = au.author_id
     JOIN "Article" AS a ON a.article_id = aa.article_id
   - If querying "Publisher" (p), join to "Journal" (j) and then to "Article" (a).
   - If querying "Institution" (ins), join to "Author" (au) and then to "Article" (a).
   Then, always apply the Article scope filter in the WHERE clause.
` : '';

    return `
        You are an expert PostgreSQL Text-to-SQL planner.
        Your job is to generate exactly ONE safe PostgreSQL SELECT query based on the user's question and the pre-computed routing decision.

        You MUST obey the routing decision:
        ROUTER_DECISION:
        ${routerDecisionJson}

        The target primary entity is: ${primaryEntity}

        Here is the database schema, table aliases, and how they relate:

        ${schemaInfo}
        ${scopeDetails}

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
export const buildFinalAnswerPrompt = (userQuestion, routeDecision, rows, scope) => {
    const contextData = rows && rows.length > 0 ? JSON.stringify(rows) : "[]";
    const routeMetadata = JSON.stringify(routeDecision, null, 2);
    const projectContext = scope ? `You are answering in the context of Project ID ${scope.projectId} (Subject Area: "${scope.subjectAreaName}").` : '';

    return `
You are an expert AI assistant for a scientific journal and paper database.
${projectContext}
You must answer the user's question using ONLY the database context provided.

Context is formatted as a JSON string of database rows:
${contextData}

Routing metadata:
${routeMetadata}

Rules:
1. LANGUAGE RULE: Detect the language of the Original User Question. You MUST write your entire response (including all introductory text, transition sentences, summaries, and label names) in that EXACT same language.
   - If the user question is in Japanese, the entire response MUST be in Japanese.
   - If the user question is in Vietnamese, the entire response MUST be in Vietnamese.
   - If the user question is in English, the entire response MUST be in English.
   - NEVER mix languages. Do NOT output bilingual labels (e.g. do not write "Author / Tác giả" or mix English/Vietnamese labels in a Japanese query).
2. Label Translation: You MUST translate all record labels (such as "Author", "Journal", "Citations", "Year", "Publisher", "Type", "Quartile", "Value") into the target language:
   - For Japanese: Use "著者", "ジャーナル", "引用数", "出版年", "出版社", "タイプ", "グループ", "値".
   - For Vietnamese: Use "Tác giả", "Tạp chí", "Lượt trích dẫn", "Năm xuất bản", "Nhà xuất bản", "Loại", "Phân nhóm", "Giá trị".
   - For English: Use "Author", "Journal", "Citations", "Year", "Publisher", "Type", "Quartile", "Value".
3. Use ONLY the returned database context. Do NOT invent or hallucinate data.
4. If the context is [] or empty, state clearly in the query's language that no data was found.
5. Format the output professionally as a clean, readable Markdown list. Do NOT use Markdown tables (using | and - separators), as they do not render well in chat bubbles.
   - If there are MULTIPLE records (e.g. articles, journals, authors, or rankings), present them as a numbered list (1., 2., 3.):
     - For Articles: \`1. **[Title]** - Author: [Author Name(s)] - Journal: [Journal Name] ([Publication Year]) - Citations: [Citations Count] - DOI: [DOI]\`
     - For Journals: \`1. **[Journal Name]** - Type: [Type] - Publisher: [Publisher Name] - Country: [Country] (Open Access: [Open Access])\`
     - For Authors: \`1. **[Author Name]** - Works: [Works Count] - Citations: [Citations Count] - H-Index: [H-Index]\`
     - For rankings/metrics: \`1. **[Journal Name]** - Year: [Year] - Metric: [Metric Name] - Quartile: [Quartile] - Value: [Value]\`
     - For other entities: format as a clean bulleted list highlighting the key attributes.
   - If there is ONLY ONE record, show it as a list of bullet points with bold labels.

Original User Question:
${userQuestion}

Write 100% of your response in the language of the Original User Question. Do not use any other language.
`.trim();
};
