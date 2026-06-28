import pool from '../config/database.js';
import { getProjectScope } from './forecast.service.js'; // Tái sử dụng hàm lấy scope có sẵn
import { findJournalMigrationSnapshots } from '../repositories/migration.repository.js';
import { normalizeSourceModel, normalizeTargetModel, buildInitialMigrationFlow, calculateTransitionRate } from '../utils/accessModel.js';
import logger from '../../utils/logger.js';

/**
 * Service to analyze journal migration flows from a start year to an end year.
 * @param {object} query 
 */
export async function getJournalMigrationAnalysis(query) {
  let { project_id, subject_area, keywords, from_year, to_year, include_legacy } = query;

  from_year = from_year || 2024;
  to_year = to_year || 2026;

  // 1. Resolve project scope
  let scope;
  try {
    scope = await getProjectScope(pool, project_id);
  } catch (err) {
    if (err.status === 404 || err.code === 404) {
      throw err; // Spec Edge Case 1: Project not found -> throw 404
    }
    throw err;
  }

  // 2. Parse keywords string into array
  const keywordList = keywords ? keywords.split(',').map(k => k.trim()).filter(Boolean) : [];

  // 3. Build filter for repository
  const filter = {
    projectCategoryIds: scope.projectCategoryIds || [],
    projectKeywordIds: scope.projectKeywordIds || [],
    subjectArea: subject_area,
    keywordList,
    fromYear: Number(from_year),
    toYear: Number(to_year)
  };

  // 4. Get Journal Snapshots directly (avoids N+1)
  const snapshots = await findJournalMigrationSnapshots(filter);

  // 5. Initialize base flow map
  const flowsMap = buildInitialMigrationFlow();

  // 6. Map and build flow
  let totalCount = 0;
  for (const row of snapshots) {
    const source = normalizeSourceModel(row.source_access_model);
    
    // Bỏ qua nếu source đã là FULL_OPEN_ACCESS từ đầu kỳ (vì chỉ phân tích migration từ đóng/lai -> mở)
    if (source === "FULL_OPEN_ACCESS") continue;

    const target = normalizeTargetModel(row.target_access_model);
    
    const key = `${source}->${target}`;
    if (flowsMap.has(key)) {
      flowsMap.set(key, flowsMap.get(key) + 1);
      totalCount++;
    } else {
       // Thêm key nếu chưa có (dù buildInitialMigrationFlow đã phủ hết 4 TH)
       flowsMap.set(key, 1);
       totalCount++;
    }
  }

  // 7. Convert map to array format
  let flows = [];
  let openAccessCount = 0;

  for (const [key, value] of flowsMap.entries()) {
    const [source, target] = key.split('->');
    
    // 8. Filter by include_legacy
    const isLegacy = (include_legacy === 'false' || include_legacy === false) && target !== 'FULL_OPEN_ACCESS';
    
    if (!isLegacy) {
      flows.push({
        source,
        target,
        value
      });
      
      if (target === 'FULL_OPEN_ACCESS') {
        openAccessCount += value;
      }
    }
  }

  // 9. Recalculate totalCount after filtering legacy
  totalCount = flows.reduce((sum, flow) => sum + flow.value, 0);
  const transitionRate = calculateTransitionRate(openAccessCount, totalCount);

  // 10. Return response
  return {
    totalCount,
    transitionRate,
    flows
  };
}
