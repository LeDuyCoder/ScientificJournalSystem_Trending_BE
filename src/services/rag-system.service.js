import pool from '../config/database.js';
import logger from '../utils/logger.js';
import { buildRouterPrompt, buildSqlPrompt, buildFinalAnswerPrompt } from './prompts.js';
import { cleanGeneratedSql, validateSql } from '../utils/sql_utils.js';

const MODEL_RAG_URL = process.env.URL_RAG_MODEL || 'http://localhost:11434/api/generate';
const RAG_MODEL = process.env.OLLAMA_MODEL || process.env.RAG_MODEL || 'llama3.1:8b';

// 1. Hàm gọi LLM Ollama Local dùng Fetch API (timeout 120s)
export const callAiLlm = async (prompt) => {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000);

        const response = await fetch(MODEL_RAG_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: RAG_MODEL,
                prompt: prompt,
                stream: false
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }

        const data = await response.json();
        return (data.response || '').trim();
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(`Lỗi kết nối Ollama Local: Yêu cầu bị hết hạn (timeout 120s)`);
        }
        throw new Error(`Lỗi kết nối Ollama Local: ${error.message}`);
    }
};

// 2. Phân tuyến câu hỏi (Router)
export const routeQuestion = async (userQuestion) => {
    const prompt = buildRouterPrompt(userQuestion);
    try {
        const rawResponse = await callAiLlm(prompt);
        const startIdx = rawResponse.indexOf('{');
        const endIdx = rawResponse.lastIndexOf('}');
        
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
            const jsonStr = rawResponse.slice(startIdx, endIdx + 1);
            return JSON.parse(jsonStr);
        }
    } catch (error) {
        logger.error(`[DEBUG ROUTER] JSON parse error:`, error);
    }
    
    // Fallback default khi lỗi hoặc không parse được JSON
    return {
        route: 'VECTOR_RAG',
        primary_entity: 'Article',
        intent_type: 'fallback',
        required_tables: ['Article'],
        reason: 'Fallback due to parse failure'
    };
};

// 3. Hàm Dịch truy vấn tiếng Việt -> tiếng Anh (hỗ trợ Vector RAG dùng model Embedding tiếng Anh)
export const translateToEnglishQuery = async (userQuestion) => {
    const prompt = `
You are a translation assistant for a scientific paper search engine.
Convert the following user query (which might be in Vietnamese) into a concise English search query or a set of English search terms that best represents the topic.
Do NOT output any intro, markdown, or explanation. Output ONLY the English search query.

User query: ${userQuestion}
English search terms:`.trim();

    try {
        return await callAiLlm(prompt);
    } catch (e) {
        return userQuestion; // fallback dùng câu hỏi gốc
    }
};

// 4. Thực thi tìm kiếm bằng SQL dựa trên Thực thể chính
export const executeEntitySql = async (userQuestion, routeDecision) => {
    const prompt = buildSqlPrompt(userQuestion, routeDecision);
    let generatedSql = "";
    
    try {
        const rawResponse = await callAiLlm(prompt);
        generatedSql = cleanGeneratedSql(rawResponse);
        validateSql(generatedSql);
        
        logger.db(`[DEBUG SQL] Executing Query: ${generatedSql}`);
        const dbResult = await pool.query(generatedSql);
        
        return {
            type: routeDecision.route,
            sql: generatedSql,
            rows: dbResult.rows,
            error: null
        };
    } catch (error) {
        logger.error(`[DEBUG LỖI] Vấn đề tại TEXT TO SQL:`, error);
        return {
            type: routeDecision.route,
            sql: generatedSql,
            rows: [],
            error: error.message
        };
    }
};

// 5. Thực thi tìm kiếm ngữ nghĩa bằng Vector RAG (pgvector)
export const executeVectorRag = async (userQuestion, routeDecision) => {
    try {
        const englishQuery = await translateToEnglishQuery(userQuestion);
        logger.info(`[DEBUG VECTOR] Translated query: ${englishQuery}`);
        
        // Hiện tại giả lập sinh vector 768 chiều cho pgvector
        const mockVector = new Array(768).fill(0.0); 
        const vectorStr = `[${mockVector.join(',')}]`;
        
        const thresholds = [0.25, 0.0];
        let rows = [];
        let usedThreshold = thresholds[0];
        
        for (const threshold of thresholds) {
            const query = `
                SELECT
                    m.article_id,
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
                    m.similarity
                FROM match_articles($1::vector, $2, 5) AS m
                JOIN "Article" AS a ON a.article_id = m.article_id
                LEFT JOIN "Issue" AS i ON a.issue_id = i.issue_id
                LEFT JOIN "Volume" AS v ON i.volume_id = v.volume_id
                LEFT JOIN "Journal" AS j ON v.journal_id = j.journal_id
                WHERE COALESCE(a.is_deleted, false) = false
                ORDER BY m.similarity DESC;
            `.trim();
            
            const dbResult = await pool.query(query, [vectorStr, threshold]);
            rows = dbResult.rows;
            usedThreshold = threshold;
            
            logger.info(`[DEBUG VECTOR] threshold=${threshold} -> ${rows.length} kết quả`);
            if (rows.length > 0) {
                break;
            }
        }
        
        return {
            type: "VECTOR_RAG",
            sql: `SELECT * FROM match_articles(query_vector, ${usedThreshold}, 5);`,
            rows: rows,
            error: null
        };
    } catch (error) {
        logger.error(`[DEBUG LỖI] Vấn đề tại VECTOR RAG:`, error);
        return {
            type: "VECTOR_RAG",
            sql: "",
            rows: [],
            error: error.message
        };
    }
};

// 6. Tạo câu trả lời cuối cùng
export const generateFinalAnswer = async (userQuestion, routeDecision, toolResult) => {
    if (toolResult.error) {
        return `⚠️ Hệ thống gặp lỗi truy vấn: ${toolResult.error}`;
    }
    const prompt = buildFinalAnswerPrompt(userQuestion, routeDecision, toolResult.rows);
    return await callAiLlm(prompt);
};

// 7. Pipeline điều phối luồng chính (Main Orchestration Pipeline)
export const chatPipeline = async (userQuestion) => {
    logger.info(`[DEBUG] Routing question: "${userQuestion}"`);
    const routeDecision = await routeQuestion(userQuestion);
    logger.info(`[DEBUG ROUTER] Decision: ${JSON.stringify(routeDecision)}`);
    
    const route = routeDecision.route;
    
    if (route === "CLARIFY") {
        return {
            routeDecision,
            toolResult: { type: "CLARIFY", sql: "", rows: [], error: null },
            answer: "Câu hỏi của bạn chưa rõ ràng. Bạn có thể nói rõ hơn bạn muốn tìm theo bài báo, tạp chí, tác giả hay rankings không?"
        };
    }
    
    logger.info(`[DEBUG] Executing tool ${route}...`);
    let toolResult;
    if (route === "VECTOR_RAG") {
        toolResult = await executeVectorRag(userQuestion, routeDecision);
    } else {
        toolResult = await executeEntitySql(userQuestion, routeDecision);
    }
    
    logger.info(`[DEBUG] Generating final answer...`);
    const answer = await generateFinalAnswer(userQuestion, routeDecision, toolResult);
    
    return {
        routeDecision,
        toolResult,
        answer
    };
};
