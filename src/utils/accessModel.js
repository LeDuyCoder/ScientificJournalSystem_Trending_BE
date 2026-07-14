/**
 * Chuẩn hoá access_model cho Source (from_year).
 * Theo spec: Thiếu cả source thì source = SUBSCRIPTION.
 * Chỉ hỗ trợ SUBSCRIPTION và HYBRID.
 */
export function normalizeSourceModel(raw) {
  if (!raw) return "SUBSCRIPTION";
  
  const lowerRaw = raw.toLowerCase().trim();
  switch (lowerRaw) {
    case "subscription":
    case "closed":
    case "paywalled":
      return "SUBSCRIPTION";
    case "hybrid":
      return "HYBRID";
    case "gold_oa":
    case "open_access":
    case "full_open_access":
      return "FULL_OPEN_ACCESS"; // Service sẽ filter bỏ nếu là FULL_OPEN_ACCESS
    default:
      return "SUBSCRIPTION"; // Fallback theo spec
  }
}

/**
 * Chuẩn hoá access_model cho Target (to_year).
 * Theo spec: Thiếu target thì target = LEGACY_MODEL.
 * Chỉ hỗ trợ FULL_OPEN_ACCESS và LEGACY_MODEL. Các mô hình đóng/lai chuyển thành LEGACY_MODEL.
 */
export function normalizeTargetModel(raw) {
  if (!raw) return "LEGACY_MODEL";

  const lowerRaw = raw.toLowerCase().trim();
  switch (lowerRaw) {
    case "gold_oa":
    case "open_access":
    case "full_open_access":
      return "FULL_OPEN_ACCESS";
    default:
      return "LEGACY_MODEL"; // Subscription, hybrid, closed, legacy, unknown đều map về LEGACY_MODEL
  }
}

/**
 * Khởi tạo sẵn flow với giá trị 0 cho các hướng chuyển đổi.
 *
 * @returns {Map<string, number>}
 */
export function buildInitialMigrationFlow() {
  const map = new Map();
  map.set("SUBSCRIPTION->FULL_OPEN_ACCESS", 0);
  map.set("HYBRID->FULL_OPEN_ACCESS", 0);
  map.set("SUBSCRIPTION->LEGACY_MODEL", 0);
  map.set("HYBRID->LEGACY_MODEL", 0);
  return map;
}

/**
 * Tính tỷ lệ chuyển đổi.
 *
 * @param {number} openAccessCount
 * @param {number} totalCount
 * @returns {number} Transition rate rounded to 1 decimal place.
 */
export function calculateTransitionRate(openAccessCount, totalCount) {
  if (totalCount === 0) return 0;
  const rate = (openAccessCount / totalCount) * 100;
  return Number(rate.toFixed(1));
}
