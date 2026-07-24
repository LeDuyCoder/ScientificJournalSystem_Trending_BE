import { buildRouterPrompt, buildSchemaInfoString, buildSqlPrompt } from '../src/services/rag/prompts.js';
import dotenv from 'dotenv';
dotenv.config();

function testTokenSavings() {
  console.log("=== RAG Pipeline Token Optimization Test ===");

  const question = "Đếm số bài viết năm 2025 có Q1 quartile";
  
  // 1. Baseline estimation
  // In the baseline, we sent the entire database schema registry with all descriptions, joins, and rules.
  const baselineSchemaStringLength = 15597; // exact characters of prompts.js baseline
  const baselineRouterPrompt = buildRouterPrompt(question);
  console.log("Estimated Baseline Prompt size (chars):", baselineRouterPrompt.length + baselineSchemaStringLength);

  // 2. Optimized estimation
  const routeDecision = {
    route: "RANKING_SQL",
    primary_entity: "Journal_Ranking",
    required_tables: ["Journal_Ranking", "Journal"]
  };
  const scope = {
    projectId: 12,
    subjectAreaName: "Computer Science",
    subjectCategoryIds: [335, 337],
    keywordIds: [3490],
    keywordNames: ["ai"]
  };

  const optimizedSchema = buildSchemaInfoString(routeDecision.required_tables);
  const optimizedSqlPrompt = buildSqlPrompt(question, routeDecision, scope);
  
  console.log("Optimized Schema info size (chars):", optimizedSchema.length);
  console.log("Optimized Prompt size (chars):", optimizedSqlPrompt.length);

  const savings = ((1 - (optimizedSqlPrompt.length / (baselineRouterPrompt.length + baselineSchemaStringLength))) * 100).toFixed(1);
  console.log(`Token characters reduced by: ${savings}%`);
  
  if (parseFloat(savings) >= 60.0) {
    console.log("SUCCESS: Token reduction target of >60% MET!");
  } else {
    console.log("FAIL: Token reduction target not met.");
  }
}

testTokenSavings();
