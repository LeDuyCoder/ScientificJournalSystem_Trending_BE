import pool from '../../../../config/database.js';
import logger from '../../../../utils/logger.js';
import { buildRouterPrompt, buildSqlPrompt, buildFinalAnswerPrompt } from '../rag/prompts.js';
import { getProjectScope } from '../../../analytics/services/trends/forecast.service.js';
import { cleanGeneratedSql, validateSql } from '../../../../utils/sql_utils.js';
import { redisGet, redisSet } from '../../../core/services/infrastructure/redis.service.js';
import { getProjectChatMessages } from './projectChatMessage.service.js';

const MODEL_RAG_URL = process.env.URL_RAG_MODEL || 'http://localhost:11434/api/generate';
const RAG_MODEL = process.env.OLLAMA_MODEL || process.env.RAG_MODEL || 'llama3.1:8b';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'nomic-embed-text';
const OLLAMA_EMBEDDING_URL = process.env.OLLAMA_EMBEDDING_URL || 'http://localhost:11434/api/embeddings';
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 300000); 
const OLLAMA_FALLBACK_TIMEOUT_MS = Number(process.env.OLLAMA_FALLBACK_TIMEOUT_MS || 300000); 
const EMBEDDING_TIMEOUT_MS = Number(process.env.EMBEDDING_TIMEOUT_MS || 60000); 

const buildArticleScopeFilter = (scope, params) => {
    const filters = [];

    if (scope.subjectCategoryIds.length > 0) {
        params.push(scope.subjectCategoryIds);
        const paramIndex = params.length;
        filters.push(`
            (
                EXISTS (
                    SELECT 1
                    FROM "Topic" AS primary_topic
                    WHERE primary_topic.topic_id = a.primary_topic
                      AND primary_topic.subject_category_id = ANY($${paramIndex}::bigint[])
                )
                OR EXISTS (
                    SELECT 1
                    FROM "Sub_Topic" AS st
                    JOIN "Topic" AS sub_topic ON st.topic_id = sub_topic.topic_id
                    WHERE st.article_id = a.article_id
                      AND sub_topic.subject_category_id = ANY($${paramIndex}::bigint[])
                )
            )
        `);
    }

    if (scope.keywordIds.length > 0) {
        params.push(scope.keywordIds);
        const paramIndex = params.length;
        filters.push(`
            EXISTS (
                SELECT 1
                FROM "Keyword_Article" AS ka
                WHERE ka.article_id = a.article_id
                  AND ka.keyword_id = ANY($${paramIndex}::bigint[])
            )
        `);
    }

    return filters.length > 0 ? `AND (${filters.join(' OR ')})` : 'AND FALSE';
};

const buildResponseTable = (rows, routeDecision) => {
    if (!rows || rows.length === 0) return null;

    const route = routeDecision?.route || '';
    const isArticleRoute = route === 'ARTICLE_SQL' || rows.some(row => row.article_id && row.title);
    const isRankingRoute = route === 'RANKING_SQL' || rows.some(row => row.value_txt || row.metric_name);
    const isStatsRoute = route === 'STATS_SQL' || rows.some(row => row.count !== undefined || row.total !== undefined || row.avg !== undefined);

    let columns = [];
    if (isStatsRoute) {
        // Auto-detect columns from aggregated rows
        columns = Object.keys(rows[0]).slice(0, 8).map(key => ({
            key: key,
            label: key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ')
        }));
    } else if (isArticleRoute) {
        columns = [
            { key: 'article_id', label: 'ID' },
            { key: 'title', label: 'Tiêu đề' },
            { key: 'authors', label: 'Tác giả' },
            { key: 'journal_name', label: 'Tạp chí' },
            { key: 'publication_year', label: 'Năm XB' },
            { key: 'citation_count', label: 'Lượt trích dẫn' }
        ];
    } else if (isRankingRoute) {
        columns = [
            { key: 'journal_name', label: 'Tên tạp chí' },
            { key: 'year', label: 'Năm' },
            { key: 'metric_name', label: 'Chỉ số' },
            { key: 'value_txt', label: 'Phân nhóm' },
            { key: 'value_float', label: 'Giá trị' },
            { key: 'publisher_name', label: 'Nhà xuất bản' }
        ];
    } else {
        columns = Object.keys(rows[0]).slice(0, 8).map(key => ({
            key: key,
            label: key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ')
        }));
    }

    return {
        columns,
        data: rows
    };
};

const detectUserLanguage = (text) => {
    if (/[ - ]*[ - ]/.test(text) && /[ - ]/.test(text) && !/[\u3040-\u30ff\u3400-\u9fff]/.test(text) && !/[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i.test(text)) {
        return 'en';
    }
    if (/[\u3040-\u30ff\u3400-\u9fff]/.test(text)) return 'ja';
    if (/[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i.test(text)) return 'vi';
    return 'en';
};

const buildOutOfScopeAnswer = (userQuestion) => {
    const lang = detectUserLanguage(userQuestion);
    if (lang === 'ja') return 'この内容はプロジェクトの範囲外です。';
    if (lang === 'vi') return 'Nội dung này không thuộc phạm vi dự án.';
    return 'This content is outside the scope of the project.';
};

const DOMAIN_KEYWORDS = {
    'Computer Science': [
        'computer', 'software', 'algorithm', 'ai', 'artificial intelligence', 'machine learning', 'deep learning', 'data mining', 'network', 'cybersecurity',
        'máy tính', 'phần mềm', 'thuật toán', 'trí tuệ nhân tạo', 'học máy', 'học sâu', 'mạng', 'an ninh mạng',
        'コンピュータ', 'ソフトウェア', 'アルゴリズム', '人工知能', '機械学習', '深層学習', 'ネットワーク', 'サイバーセキュリティ'
    ],
    'Agricultural': [
        'agriculture', 'agricultural', 'crop', 'soil', 'plant', 'farming', 'livestock', 'irrigation', 'fertilizer', 'food science',
        'nông nghiệp', 'cây trồng', 'đất', 'thực vật', 'chăn nuôi', 'tưới tiêu', 'phân bón', 'khoa học thực phẩm',
        '農業', '作物', '土壌', '植物', '畜産', '灌漑', '肥料', '食品科学'
    ],
    'Medicine': [
        'medicine', 'medical', 'clinical', 'disease', 'patient', 'doctor', 'hospital', 'cancer', 'virus', 'healthcare',
        'y học', 'bệnh', 'bệnh nhân', 'bác sĩ', 'bệnh viện', 'ung thư', 'virus', 'chăm sóc sức khỏe',
        '医学', '医療', '臨床', '病気', '患者', '医師', '病院', 'がん', 'ウイルス', 'ヘルスケア'
    ],
    'Social Sciences': [
        'social', 'education', 'economics', 'psychology', 'sociology', 'policy', 'law', 'culture',
        'xã hội', 'giáo dục', 'kinh tế', 'tâm lý', 'xã hội học', 'chính sách', 'luật', 'văn hóa',
        '社会', '教育', '経済', '心理学', '社会学', '政策', '法律', '文化'
    ]
};

const normalizeText = (text) => String(text || '').toLowerCase();

const isQuestionOutsideProjectScope = (userQuestion, scope) => {
    const question = normalizeText(userQuestion);
    const subjectArea = scope?.subjectAreaName || '';
    const projectKeywords = (scope?.keywordNames || []).map(normalizeText);

    if (normalizeText(subjectArea) && question.includes(normalizeText(subjectArea))) return false;
    if (projectKeywords.some(keyword => keyword && question.includes(keyword))) return false;

    const matchedDomains = Object.entries(DOMAIN_KEYWORDS)
        .filter(([, keywords]) => keywords.some(keyword => question.includes(normalizeText(keyword))))
        .map(([domain]) => domain);

    if (matchedDomains.length === 0) return false;
    return !matchedDomains.some(domain => normalizeText(domain) === normalizeText(subjectArea));
};

const AI_PROVIDER = process.env.AI_PROVIDER || 'ollama'; 
const AI_MODEL = process.env.AI_MODEL || process.env.OLLAMA_MODEL || process.env.RAG_MODEL || 'llama3.1:8b';
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_ENDPOINT = process.env.AI_ENDPOINT || '';

const callOllamaFallback = async (prompt) => {
    logger.info(`[AI CLIENT FALLBACK] Bắt đầu gọi Local Ollama fallback (Model: llama3.1:8b)...`);
    const fallbackUrl = 'http://localhost:11434/api/generate';
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), OLLAMA_FALLBACK_TIMEOUT_MS);

        const response = await fetch(fallbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'llama3.1:8b',
                prompt: prompt,
                stream: false
            }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`Ollama fallback HTTP error: ${response.status}`);
        }
        const data = await response.json();
        logger.info(`[AI CLIENT FALLBACK] Local Ollama phản hồi thành công.`);
        const promptTokens = data.prompt_eval_count || 0;
        const completionTokens = data.eval_count || 0;
        return {
            text: (data.response || '').trim(),
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens
        };
    } catch (e) {
        logger.error(`[AI CLIENT FALLBACK LỖI] Cả local Ollama fallback cũng thất bại:`, e);
        throw e;
    }
};

export const callAiLlm = async (prompt) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

    let fetchUrl = '';
    let fetchOptions = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal
    };

    if (AI_PROVIDER === 'openai') {
        fetchUrl = AI_ENDPOINT || 'https://api.openai.com/v1/chat/completions';
        fetchOptions.headers['Authorization'] = `Bearer ${AI_API_KEY}`;
        fetchOptions.body = JSON.stringify({
            model: AI_MODEL,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1
        });
    } else if (AI_PROVIDER === 'gemini') {
        fetchUrl = AI_ENDPOINT || `https://generativelanguage.googleapis.com/v1beta/models/${AI_MODEL}:generateContent?key=${AI_API_KEY}`;
        fetchOptions.body = JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1 }
        });
    } else {
        fetchUrl = AI_ENDPOINT || MODEL_RAG_URL || 'http://localhost:11434/api/generate';
        fetchOptions.body = JSON.stringify({
            model: AI_MODEL,
            prompt: prompt,
            stream: false
        });
    }

    try {
        let response;
        try {
            response = await fetch(fetchUrl, fetchOptions);
        } catch (fetchError) {
            if (AI_PROVIDER !== 'ollama') {
                logger.warn(`[AI CLIENT] Yêu cầu tới ${AI_PROVIDER} bị lỗi mạng. Chuyển sang Local Ollama...`);
                clearTimeout(timeoutId);
                return await callOllamaFallback(prompt);
            }
            throw fetchError;
        }

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            if (AI_PROVIDER !== 'ollama') {
                logger.warn(`[AI CLIENT] ${AI_PROVIDER} trả về lỗi. Chuyển sang Local Ollama...`);
                return await callOllamaFallback(prompt);
            }
            throw new Error(`HTTP error! Status: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        let resultText = '';
        let promptTokens = 0;
        let completionTokens = 0;
        let totalTokens = 0;

        if (AI_PROVIDER === 'openai') {
            resultText = data.choices?.[0]?.message?.content || '';
            promptTokens = data.usage?.prompt_tokens || 0;
            completionTokens = data.usage?.completion_tokens || 0;
            totalTokens = data.usage?.total_tokens || 0;
        } else if (AI_PROVIDER === 'gemini') {
            resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            promptTokens = data.usageMetadata?.promptTokenCount || 0;
            completionTokens = data.usageMetadata?.candidatesTokenCount || 0;
            totalTokens = data.usageMetadata?.totalTokenCount || 0;
        } else {
            resultText = data.response || '';
            promptTokens = data.prompt_eval_count || 0;
            completionTokens = data.eval_count || 0;
            totalTokens = promptTokens + completionTokens;
        }

        return {
            text: resultText.trim(),
            promptTokens,
            completionTokens,
            totalTokens
        };
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(`Lỗi kết nối AI: Hết hạn (${Math.round(AI_TIMEOUT_MS / 1000)}s)`);
        }
        throw new Error(`Lỗi kết nối AI: ${error.message}`);
    }
};

export const routeQuestion = async (userQuestion) => {
    const prompt = buildRouterPrompt(userQuestion);
    try {
        const { text: rawResponse, promptTokens, completionTokens, totalTokens } = await callAiLlm(prompt);
        const startIdx = rawResponse.indexOf('{');
        const endIdx = rawResponse.lastIndexOf('}');
        
        let parsedRoute = {
            route: 'VECTOR_RAG',
            primary_entity: 'Article',
            intent_type: 'fallback',
            required_tables: ['Article'],
            reason: 'Fallback due to parse failure'
        };

        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
            try {
                const jsonStr = rawResponse.slice(startIdx, endIdx + 1);
                parsedRoute = JSON.parse(jsonStr);
            } catch (error) {
                logger.error(`[DEBUG ROUTER] JSON parse error:`, error);
            }
        }

        return {
            routeDecision: parsedRoute,
            tokens: { promptTokens, completionTokens, totalTokens }
        };
    } catch (error) {
        logger.error(`[DEBUG ROUTER] Router error:`, error);
        return {
            routeDecision: {
                route: 'VECTOR_RAG',
                primary_entity: 'Article',
                intent_type: 'fallback',
                required_tables: ['Article'],
                reason: 'Fallback due to router failure: ' + error.message
            },
            tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
        };
    }
};

const buildEmbeddingVector = async (text) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);

    const provider = process.env.EMBEDDING_PROVIDER || AI_PROVIDER || 'ollama';
    let url, fetchOptions, responseParser;

    if (provider === 'gemini') {
        const geminiModel = process.env.GEMINI_EMBEDDING_MODEL || 'text-embedding-004';
        url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:embedContent?key=${AI_API_KEY}`;
        fetchOptions = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: `models/${geminiModel}`,
                content: { parts: [{ text: text }] }
            }),
            signal: controller.signal
        };
        responseParser = (data) => data?.embedding?.values;
    } else {
        url = OLLAMA_EMBEDDING_URL;
        fetchOptions = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: EMBEDDING_MODEL,
                prompt: text
            }),
            signal: controller.signal
        };
        responseParser = (data) => data?.embedding;
    }

    try {
        const response = await fetch(url, fetchOptions);
        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`${provider} embedding HTTP ${response.status}: ${errorText}`);
        }

        const data = await response.json();
        const embedding = responseParser(data);

        if (!Array.isArray(embedding) || embedding.length === 0) {
            throw new Error(`${provider} embedding response không có vector hợp lệ`);
        }

        return embedding;
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
};

export const translateToEnglishQuery = async (userQuestion) => {
    const prompt = `
You are a translation assistant for a scientific paper search engine.
Convert the following user query (which might be in Vietnamese) into a concise English search query or a set of English search terms that best represents the topic.
Do NOT output any intro, markdown, or explanation. Output ONLY the English search query.

User query: ${userQuestion}
English search terms:`.trim();

    try {
        const { text, promptTokens, completionTokens, totalTokens } = await callAiLlm(prompt);
        return {
            englishQuery: text,
            tokens: { promptTokens, completionTokens, totalTokens }
        };
    } catch (e) {
        return {
            englishQuery: userQuestion,
            tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
        };
    }
};

const executeArticleSqlTemplate = async (scope) => {
    const params = [];
    const scopeFilter = buildArticleScopeFilter(scope, params);
    const query = `
        SELECT DISTINCT
            a.article_id,
            a.title,
            a.abstract,
            a.publication_year,
            a.doi,
            COALESCE(a.citation_count, 0) AS citation_count,
            a.semantic_tldr,
            j.display_name AS journal_name,
            (
                SELECT string_agg(au.display_name, ', ')
                FROM "Author_Article" AS aa
                JOIN "Author" AS au ON au.author_id = aa.author_id
                WHERE aa.article_id = a.article_id
                  AND COALESCE(au.is_deleted, false) = false
            ) AS authors
        FROM "Article" AS a
        LEFT JOIN "Issue" AS i ON i.issue_id = a.issue_id
        LEFT JOIN "Volume" AS v ON v.volume_id = i.volume_id
        LEFT JOIN "Journal" AS j ON j.journal_id = v.journal_id
        WHERE COALESCE(a.is_deleted, false) = false
          ${scopeFilter}
        ORDER BY citation_count DESC NULLS LAST, a.publication_year DESC NULLS LAST
        LIMIT 20;
    `.trim();

    const dbResult = await pool.query(query, params);

    return {
        type: "ARTICLE_SQL",
        sql: query,
        rows: dbResult.rows,
        error: null
    };
};

const executeRankingSqlTemplate = async (scope, userQuestion) => {
    const params = [];
    const scopeFilter = buildArticleScopeFilter(scope, params);

    const yearMatch = userQuestion.match(/(20\d{2})/);
    const targetYear = yearMatch ? Number(yearMatch[1]) : null;

    const quartileMatch = userQuestion.match(/\b(Q[1-4])\b/i);
    const quartile = quartileMatch ? quartileMatch[1].toUpperCase() : null;

    let yearClause = '';
    if (targetYear) {
        params.push(targetYear);
        yearClause = `AND jr.year = $${params.length}`;
    }

    let quartileClause = '';
    if (quartile) {
        params.push(`%${quartile}%`);
        quartileClause = `AND jr.value_txt ILIKE $${params.length}`;
    }

    const query = `
        SELECT DISTINCT
            j.journal_id,
            j.display_name AS journal_name,
            jr.year,
            jr.value_txt,
            jr.value_int,
            jr.value_float,
            rm.display_name AS metric_name,
            p.display_name AS publisher_name
        FROM "Journal" AS j
        LEFT JOIN "Publisher" AS p ON p.publisher_id = j.publisher_id
        JOIN "Volume" AS v ON v.journal_id = j.journal_id
        JOIN "Issue" AS i ON i.volume_id = v.volume_id
        JOIN "Article" AS a ON a.issue_id = i.issue_id
        JOIN "Journal_Ranking" AS jr ON jr.journal_id = j.journal_id
        LEFT JOIN "Ranking_Metric" AS rm ON rm.metric_id = jr.metric_id
        WHERE COALESCE(j.is_deleted, false) = false
          AND COALESCE(a.is_deleted, false) = false
          ${yearClause}
          ${quartileClause}
          ${scopeFilter}
        ORDER BY jr.year DESC, j.display_name ASC
        LIMIT 20;
    `.trim();

    const dbResult = await pool.query(query, params);

    return {
        type: "RANKING_SQL",
        sql: query,
        rows: dbResult.rows,
        error: null
    };
};

const runEntitySqlOnce = async (userQuestion, routeDecision, scope, repairContext = null) => {
    const prompt = buildSqlPrompt(userQuestion, routeDecision, scope, repairContext);
    let generatedSql = "";
    let tokens = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    try {
        const res = await callAiLlm(prompt);
        const rawResponse = res.text;
        tokens = res.tokens;
        let rawSql = "";
        const jsonStart = rawResponse.indexOf('{');
        const jsonEnd = rawResponse.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
            try {
                const parsed = JSON.parse(rawResponse.slice(jsonStart, jsonEnd + 1));
                rawSql = parsed.sql || "";
            } catch {
                rawSql = cleanGeneratedSql(rawResponse);
            }
        } else {
            rawSql = cleanGeneratedSql(rawResponse);
        }

        if (scope) {
            const categoriesSql = scope.subjectCategoryIds.length > 0
                ? `ARRAY[${scope.subjectCategoryIds.join(', ')}]::bigint[]`
                : `ARRAY[]::bigint[]`;
            const keywordsSql = scope.keywordIds.length > 0
                ? `ARRAY[${scope.keywordIds.join(', ')}]::bigint[]`
                : `ARRAY[]::bigint[]`;
            rawSql = rawSql
                .replace(/__PROJECT_SUBJECT_CATEGORIES__/g, categoriesSql)
                .replace(/__PROJECT_KEYWORD_IDS__/g, keywordsSql);
        }

        generatedSql = rawSql;
        validateSql(generatedSql);

        logger.db(`[DEBUG SQL] Executing Query: ${generatedSql}`);
        const dbResult = await pool.query(generatedSql);
        return { sql: generatedSql, rows: dbResult.rows, tokens };
    } catch (err) {
        err.sql = generatedSql;
        err.tokens = tokens;
        throw err;
    }
};

export const executeEntitySql = async (userQuestion, routeDecision, scope) => {
    let lastSql = "";
    let lastError = null;
    let accumulatedTokens = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    // First attempt
    try {
        const { sql, rows, tokens } = await runEntitySqlOnce(userQuestion, routeDecision, scope);
        if (tokens) {
            accumulatedTokens.promptTokens += tokens.promptTokens;
            accumulatedTokens.completionTokens += tokens.completionTokens;
            accumulatedTokens.totalTokens += tokens.totalTokens;
        }
        return { type: routeDecision.route, sql, rows, error: null, tokens: accumulatedTokens };
    } catch (error) {
        lastSql = error.sql || lastSql;
        lastError = error.message || String(error);
        if (error.tokens) {
            accumulatedTokens.promptTokens += error.tokens.promptTokens;
            accumulatedTokens.completionTokens += error.tokens.completionTokens;
            accumulatedTokens.totalTokens += error.tokens.totalTokens;
        }
        logger.warn(`[SQL RETRY] First attempt failed: ${lastError}. Trying self-repair...`);
    }

    // Second attempt: feed the error back to AI so it can auto-fix
    try {
        const { sql, rows, tokens } = await runEntitySqlOnce(userQuestion, routeDecision, scope, {
            sql: lastSql,
            error: lastError
        });
        if (tokens) {
            accumulatedTokens.promptTokens += tokens.promptTokens;
            accumulatedTokens.completionTokens += tokens.completionTokens;
            accumulatedTokens.totalTokens += tokens.totalTokens;
        }
        logger.info(`[SQL RETRY] Self-repair succeeded.`);
        return { type: routeDecision.route, sql, rows, error: null, tokens: accumulatedTokens };
    } catch (error) {
        logger.error(`[DEBUG Lỗi] SQL self-repair also failed:`, error);
        if (error.tokens) {
            accumulatedTokens.promptTokens += error.tokens.promptTokens;
            accumulatedTokens.completionTokens += error.tokens.completionTokens;
            accumulatedTokens.totalTokens += error.tokens.totalTokens;
        }
        return {
            type: routeDecision.route,
            sql: lastSql,
            rows: [],
            error: error.message || String(error),
            tokens: accumulatedTokens
        };
    }
};

export const executeVectorRag = async (userQuestion, routeDecision, scope) => {
    let accumulatedTokens = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    try {
        const { englishQuery, tokens: translateTokens } = await translateToEnglishQuery(userQuestion);
        if (translateTokens) {
            accumulatedTokens.promptTokens += translateTokens.promptTokens;
            accumulatedTokens.completionTokens += translateTokens.completionTokens;
            accumulatedTokens.totalTokens += translateTokens.totalTokens;
        }

        const queryEmbedding = await buildEmbeddingVector(englishQuery);
        const vectorStr = `[${queryEmbedding.join(',')}]`;

        const thresholds = [0.25, 0.0];
        let rows = [];
        let usedThreshold = thresholds[0];
        let finalScopeFilter = '';

        for (const threshold of thresholds) {
            const params = [vectorStr, threshold];
            const scopeFilter = buildArticleScopeFilter(scope, params);
            finalScopeFilter = scopeFilter;
            const query = `
                SELECT
                    a.article_id,
                    a.title,
                    a.abstract,
                    a.publication_year,
                    a.doi,
                    a.citation_count,
                    a.semantic_tldr,
                    j.display_name AS journal_name,
                    (
                        SELECT string_agg(au.display_name, ', ')
                        FROM "Author_Article" AS aa
                        JOIN "Author" AS au ON au.author_id = aa.author_id
                        WHERE aa.article_id = a.article_id AND au.is_deleted = false
                    ) AS authors,
                    (1 - (a.embedding <=> $1::vector))::double precision AS similarity
                FROM "Article" AS a
                LEFT JOIN "Issue" AS i ON a.issue_id = i.issue_id
                LEFT JOIN "Volume" AS v ON v.volume_id = i.volume_id
                LEFT JOIN "Journal" AS j ON j.journal_id = v.journal_id
                WHERE COALESCE(a.is_deleted, false) = false
                  AND a.embedding IS NOT NULL
                  AND (1 - (a.embedding <=> $1::vector)) >= $2
                  ${scopeFilter}
                ORDER BY a.embedding <=> $1::vector
                LIMIT 5;
            `.trim();

            const dbResult = await pool.query(query, params);
            rows = dbResult.rows;
            usedThreshold = threshold;

            if (rows.length > 0) {
                break;
            }
        }

        return {
            type: "VECTOR_RAG",
            sql: `SELECT * FROM "Article" a WHERE a.embedding IS NOT NULL AND (1 - (a.embedding <=> query_vector)) >= ${usedThreshold} ${finalScopeFilter} ORDER BY a.embedding <=> query_vector LIMIT 5;`,
            rows: rows,
            error: null,
            tokens: accumulatedTokens
        };
    } catch (error) {
        logger.error(`[DEBUG Lỗi] Vấn đề tại VECTOR RAG:`, error);
        return {
            type: "VECTOR_RAG",
            sql: "",
            rows: [],
            error: error.message || String(error),
            tokens: accumulatedTokens
        };
    }
};

const buildSmartMarkdownFallback = (userQuestion, rows, routeDecision) => {
    const lang = detectUserLanguage(userQuestion);
    
    let intro = 'Dưới đây là kết quả truy xuất dữ liệu:';
    let authorLabel = 'Tác giả';
    let journalLabel = 'Tạp chí';
    let yearLabel = 'Năm xuất bản';
    let citationsLabel = 'Lượt trích dẫn';
    let metricLabel = 'Chỉ số';
    let valueLabel = 'Giá trị';
    let quartileLabel = 'Phân nhóm';

    if (lang === 'ja') {
        intro = '以下はデータ抽出結果です：';
        authorLabel = '著者';
        journalLabel = 'ジャーナル';
        yearLabel = '出版年';
        citationsLabel = '引用数';
        metricLabel = '指標';
        valueLabel = '数値';
        quartileLabel = 'グループ';
    } else if (lang === 'en') {
        intro = 'Here are the retrieved records:';
        authorLabel = 'Author';
        journalLabel = 'Journal';
        yearLabel = 'Publication Year';
        citationsLabel = 'Citations';
        metricLabel = 'Metric';
        valueLabel = 'Value';
        quartileLabel = 'Quartile';
    }

    const route = routeDecision?.route || '';
    const isStatsRoute = route === 'STATS_SQL' || rows.some(row => row.count !== undefined || row.total !== undefined || row.avg !== undefined);
    const isArticleRoute = !isStatsRoute && (route === 'ARTICLE_SQL' || rows.some(row => row.article_id && row.title));
    const isRankingRoute = !isStatsRoute && (route === 'RANKING_SQL' || rows.some(row => row.value_txt || row.metric_name));
    
    let md = `${intro}\n\n`;

    if (isStatsRoute) {
        // Render as markdown table for aggregated statistics
        const keys = Object.keys(rows[0]);
        const headerLabels = keys.map(k => k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' '));
        md += '| ' + headerLabels.join(' | ') + ' |\n';
        md += '| ' + keys.map(() => '---').join(' | ') + ' |\n';
        rows.forEach(row => {
            md += '| ' + keys.map(k => row[k] !== null && row[k] !== undefined ? String(row[k]) : 'N/A').join(' | ') + ' |\n';
        });
    } else if (isArticleRoute) {
        rows.forEach((row, i) => {
            const title = row.title || 'N/A';
            const author = row.authors || 'N/A';
            const journal = row.journal_name || 'N/A';
            const year = row.publication_year || 'N/A';
            const citations = row.citation_count !== undefined ? row.citation_count : 'N/A';
            const doi = row.doi ? ` - DOI: ${row.doi}` : '';
            md += `${i + 1}. **${title}** - ${authorLabel}: ${author} - ${journalLabel}: ${journal} (${year}) - ${citationsLabel}: ${citations}${doi}\n`;
        });
    } else if (isRankingRoute) {
        rows.forEach((row, i) => {
            const journal = row.journal_name || 'N/A';
            const year = row.year || 'N/A';
            const metric = row.metric_name || 'N/A';
            const val = row.value_float !== undefined ? row.value_float : (row.value_txt || 'N/A');
            const quartile = row.value_txt || 'N/A';
            md += `${i + 1}. **${journal}** - ${yearLabel}: ${year} - ${metricLabel}: ${metric} - ${quartileLabel}: ${quartile} - ${valueLabel}: ${val}\n`;
        });
    } else {
        rows.forEach((row, i) => {
            const name = row.display_name || row.name || row.title || Object.values(row)[0] || 'Record';
            const details = Object.entries(row)
                .filter(([k]) => !['display_name', 'name', 'title'].includes(k) && !k.endsWith('_id') && !k.startsWith('is_'))
                .map(([k, v]) => `**${k}**: ${v}`)
                .join(' - ');
            md += `${i + 1}. **${name}**${details ? ' - ' + details : ''}\n`;
        });
    }

    return md.trim();
};

export const generateFinalAnswer = async (userQuestion, routeDecision, toolResult, scope) => {
    let tokens = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    if (toolResult.error) {
        return { 
            answer: `Rất tiếc, hệ thống đang gặp chút khó khăn khi truy xuất dữ liệu phân tích này. Vui lòng thử diễn đạt lại câu hỏi rõ ràng hơn nhé!`, 
            fromFallback: true,
            tokens
        };
    }

    if (!toolResult.rows || toolResult.rows.length === 0) {
        return { answer: 'Hiện tại CSDL chưa tìm thấy dữ liệu phù hợp với yêu cầu này.', fromFallback: false, tokens };
    }

    const prompt = buildFinalAnswerPrompt(userQuestion, routeDecision, toolResult.rows, scope);
    try {
        const res = await callAiLlm(prompt);
        return { answer: res.text, fromFallback: false, tokens: res.tokens };
    } catch (llmError) {
        logger.error(`[DEBUG Lỗi] Lỗi sinh câu trả lời từ AI (sử dụng Smart Fallback):`, llmError);
        const answer = buildSmartMarkdownFallback(userQuestion, toolResult.rows, routeDecision);
        return { answer, fromFallback: true, tokens };
    }
};

export const chatPipeline = async (userQuestion, projectId, userId = null) => {
    let accumulatedTokens = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    logger.info(`[DEBUG] Loading project scope for project ${projectId}`);
    const scope = await getProjectScope(pool, projectId);

    if (isQuestionOutsideProjectScope(userQuestion, scope)) {
        return {
            routeDecision: {
                route: 'OUT_OF_SCOPE',
                primary_entity: null,
                intent_type: 'outside_project_scope',
                required_tables: [],
                reason: 'The requested topic does not match the current project subject area.'
            },
            toolResult: { type: 'OUT_OF_SCOPE', sql: '', rows: [], error: null },
            answer: buildOutOfScopeAnswer(userQuestion),
            fromFallback: false,
            table: null,
            tokens: accumulatedTokens
        };
    }

    // ---------- LOCAL GREETING DETECTION (saves 1 API call) ----------
    const greetingPattern = /^\s*(xin chào|chào|hello|hi|hey|bạn là ai|bạn là gì|hệ thống này là gì|giới thiệu|bạn có thể làm gì|bạn làm được gì|what can you do|who are you|what is this|introduce yourself|help me|hướng dẫn|cách sử dụng)\b/i;
    if (greetingPattern.test(userQuestion)) {
        const lang = detectUserLanguage(userQuestion);
        let greetingAnswer;
        if (lang === 'vi' || lang === 'ja') {
            greetingAnswer = `Xin chào! 👋 Tôi là **trợ lý phân tích dữ liệu** của hệ thống **Scientific Journal Trending System**.\n\n` +
                `Hệ thống này giúp bạn:\n` +
                `- 📊 **Phân tích & thống kê** dữ liệu xuất bản khoa học (số lượng bài báo theo năm, khu vực, lĩnh vực...)\n` +
                `- 🔍 **Tìm kiếm bài báo** theo chủ đề, tác giả, DOI, từ khóa\n` +
                `- 🏆 **Xếp hạng tạp chí** theo Quartile (Q1-Q4), SJR, H-Index\n` +
                `- 👤 **Tra cứu tác giả**, tổ chức nghiên cứu\n` +
                `- 📈 **Dự báo xu hướng** phát triển nghiên cứu\n\n` +
                `Hãy đặt câu hỏi cụ thể, ví dụ: *"Thống kê số bài báo theo từng năm"* hoặc *"Top tạp chí Q1 năm 2024"*.`;
        } else {
            greetingAnswer = `Hello! 👋 I'm the **data analysis assistant** of the **Scientific Journal Trending System**.\n\n` +
                `This system helps you:\n` +
                `- 📊 **Analyze & aggregate** scientific publication data (article counts by year, region, field...)\n` +
                `- 🔍 **Search articles** by topic, author, DOI, keywords\n` +
                `- 🏆 **Journal rankings** by Quartile (Q1-Q4), SJR, H-Index\n` +
                `- 👤 **Look up authors** and research institutions\n` +
                `- 📈 **Forecast research trends**\n\n` +
                `Ask a specific question, e.g. *"How many articles were published each year?"* or *"Top Q1 journals in 2024"*.`;
        }
        return {
            routeDecision: { route: 'GREETING_INTRO', primary_entity: null, intent_type: 'greeting', required_tables: [], reason: 'Local greeting detection' },
            toolResult: { type: 'GREETING_INTRO', sql: '', rows: [], error: null },
            answer: greetingAnswer,
            fromFallback: false,
            table: null,
            tokens: accumulatedTokens
        };
    }

    // ---------- HISTORY CONTEXT (optimized: max 3 msgs, truncated to 100 chars) ----------
    let summaryHistory = '';
    if (userId) {
        try {
            const historyMessages = await getProjectChatMessages(projectId, userId, { limit: 3, order: 'desc' });
            if (historyMessages && historyMessages.length > 0) {
                summaryHistory = historyMessages
                    .reverse()
                    .map(m => {
                        const content = String(m.content || '').substring(0, 100);
                        return `${m.role}: ${content}`;
                    })
                    .join(' | ');
                logger.info(`[CHAT HISTORY] Loaded ${historyMessages.length} messages context (truncated).`);
            }
        } catch (e) {
            logger.warn(`[CHAT HISTORY] Failed to retrieve history context: ${e.message}`);
        }
    }

    const modifiedUserQuestion = summaryHistory 
        ? `[Context: ${summaryHistory}] Question: ${userQuestion}`
        : userQuestion;

    logger.info(`[DEBUG] Routing question: "${userQuestion}"`);
    const { routeDecision, tokens: routeTokens } = await routeQuestion(userQuestion);
    if (routeTokens) {
        accumulatedTokens.promptTokens += routeTokens.promptTokens;
        accumulatedTokens.completionTokens += routeTokens.completionTokens;
        accumulatedTokens.totalTokens += routeTokens.totalTokens;
    }

    const route = routeDecision.route;

    // ---------- GREETING from AI router (fallback if local regex missed) ----------
    if (route === "GREETING_INTRO") {
        const lang = detectUserLanguage(userQuestion);
        let greetingAnswer;
        if (lang === 'vi' || lang === 'ja') {
            greetingAnswer = `Xin chào! 👋 Tôi là **trợ lý phân tích dữ liệu** của hệ thống **Scientific Journal Trending System**.\n\n` +
                `Hệ thống này giúp bạn:\n` +
                `- 📊 **Phân tích & thống kê** dữ liệu xuất bản khoa học\n` +
                `- 🔍 **Tìm kiếm bài báo** theo chủ đề, tác giả, DOI\n` +
                `- 🏆 **Xếp hạng tạp chí** theo Quartile, SJR, H-Index\n` +
                `- 👤 **Tra cứu tác giả**, tổ chức nghiên cứu\n` +
                `- 📈 **Dự báo xu hướng** phát triển nghiên cứu\n\n` +
                `Hãy đặt câu hỏi cụ thể, ví dụ: *"Thống kê số bài báo theo từng năm"*.`;
        } else {
            greetingAnswer = `Hello! 👋 I'm the **data analysis assistant** of the **Scientific Journal Trending System**.\n\n` +
                `This system helps you analyze scientific publication data, search articles, rank journals, and forecast trends.\n\n` +
                `Ask a specific question, e.g. *"How many articles were published each year?"*.`;
        }
        return {
            routeDecision,
            toolResult: { type: 'GREETING_INTRO', sql: '', rows: [], error: null },
            answer: greetingAnswer,
            fromFallback: false,
            table: null,
            tokens: accumulatedTokens
        };
    }

    if (route === "CLARIFY") {
        return {
            routeDecision,
            toolResult: { type: "CLARIFY", sql: "", rows: [], error: null },
            answer: "Câu hỏi của bạn chưa rõ ràng. Bạn có thể nói rõ hơn bạn muốn tìm theo bài báo, tạp chí, tác giả hay rankings không?",
            fromFallback: false,
            table: null,
            tokens: accumulatedTokens
        };
    }

    // ---------- TOOL ROUTING (clean, no force-template) ----------
    let toolResult;

    if (route === "VECTOR_RAG") {
        toolResult = await executeVectorRag(modifiedUserQuestion, routeDecision, scope);
    } else if (route === "ARTICLE_SQL") {
        // Only use article template when AI explicitly routes here for listing
        toolResult = await executeArticleSqlTemplate(scope);
    } else if (route === "RANKING_SQL") {
        toolResult = await executeRankingSqlTemplate(scope, modifiedUserQuestion);
    } else {
        // STATS_SQL, JOURNAL_SQL, AUTHOR_SQL, PUBLISHER_SQL, SUBJECT_SQL, TOPIC_SQL, KEYWORD_SQL, INSTITUTION_SQL
        // All go through dynamic text-to-SQL (supports GROUP BY for stats)
        toolResult = await executeEntitySql(modifiedUserQuestion, routeDecision, scope);
    }

    if (toolResult && toolResult.tokens) {
        accumulatedTokens.promptTokens += toolResult.tokens.promptTokens;
        accumulatedTokens.completionTokens += toolResult.tokens.completionTokens;
        accumulatedTokens.totalTokens += toolResult.tokens.totalTokens;
    }

    const { answer, fromFallback, tokens: finalAnswerTokens } = await generateFinalAnswer(modifiedUserQuestion, routeDecision, toolResult, scope);
    if (finalAnswerTokens) {
        accumulatedTokens.promptTokens += finalAnswerTokens.promptTokens;
        accumulatedTokens.completionTokens += finalAnswerTokens.completionTokens;
        accumulatedTokens.totalTokens += finalAnswerTokens.totalTokens;
    }

    const table = buildResponseTable(toolResult.rows, routeDecision);

    return {
        routeDecision,
        toolResult,
        answer,
        fromFallback,
        table,
        tokens: accumulatedTokens
    };
};
