import { neo4jDriver } from '../config/neo4j.js';
import { redisGet, redisSet } from './redis.service.js';

const CACHE_KEY = 'dashboard:stats';
const CACHE_TTL = 300; // 5 phút

// ─────────────────────────────────────────────────────────────────────────────
// CÁC HÀM TRỢ GIÚP (HELPERS)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chuyển đổi an toàn một đối tượng Neo4j Integer / number / null → số JavaScript thông thường.
 * Trả về 0 nếu giá trị là null / undefined / NaN.
 *
 * Mô phỏng lại cơ chế normalizeNeo4jValue được sử dụng trong graph.service.js.
 *
 * @param {any} value
 * @returns {number}
 */
function toSafeNumber(value) {
    if (value === null || value === undefined) return 0;
    // Đối tượng Neo4j Integer (có hàm .toNumber())
    if (typeof value.toNumber === 'function') return value.toNumber() ?? 0;
    return Number(value) || 0;
}

/**
 * Tính toán tỷ lệ tăng trưởng: growthRate = ((current - previous) / previous) * 100
 *
 * Các trường hợp đặc biệt (theo đặc tả):
 *   previous = 0, current > 0  → 100  (dữ liệu mới hoàn toàn trong kỳ này)
 *   previous = 0, current = 0  → 0    (không có dữ liệu trong cả hai kỳ)
 *   dữ liệu đầu vào null       → mặc định trả về 0
 *
 * @param {number} current
 * @param {number} previous
 * @returns {number} giá trị được làm tròn đến 1 chữ số thập phân
 */
function calcGrowthRate(current, previous) {
    const c = current ?? 0;
    const p = previous ?? 0;

    if (p === 0) return c === 0 ? 0 : 100;

    return Math.round(((c - p) / p) * 1000) / 10; // Làm tròn đến 1 chữ số thập phân
}

/**
 * Trả về giới hạn thời gian của tháng hiện tại và tháng trước dưới dạng số nguyên (YYYY, MM).
 * Được sử dụng cho các so sánh Cypher với publication_year / synced_at.
 *
 * Định nghĩa chu kỳ:
 *   current  = tháng dương lịch này
 *   previous = tháng dương lịch trước
 *
 * @returns {{
 *   currentYear:   number, currentMonth:   number,
 *   previousYear:  number, previousMonth:  number,
 *   currentStart:  string, currentEnd:     string,
 *   previousStart: string, previousEnd:    string
 * }}
 */
function getPeriodBounds() {
    const now = new Date();
    const cy = now.getFullYear();
    const cm = now.getMonth() + 1; // Hệ số 1-based cho tháng

    // tháng trước (tự động xử lý chuyển đổi từ Tháng 1 → Tháng 12 của năm trước)
    const prevDate = new Date(cy, now.getMonth() - 1, 1);
    const py = prevDate.getFullYear();
    const pm = prevDate.getMonth() + 1;

    // Chuỗi định dạng ngày ISO để so sánh mốc thời gian (Journal / Author synced_at)
    const fmt = (d) => d.toISOString().split('T')[0];
    const currentStart = fmt(new Date(cy, now.getMonth(), 1));
    const currentEnd = fmt(new Date(cy, now.getMonth() + 1, 1));
    const previousStart = fmt(new Date(py, pm - 1, 1));
    const previousEnd = fmt(new Date(py, pm, 1));

    return {
        currentYear: cy, currentMonth: cm,
        previousYear: py, previousMonth: pm,
        currentStart, currentEnd,
        previousStart, previousEnd,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// CÁC TRUY VẤN CYPHER (CYPHER QUERIES)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bài báo (Articles)
 *
 * Các trường lược đồ (schema) được sử dụng:
 *   - publication_year : kiểu integer NULL  ← trường created_at bị null trong Neo4j, sử dụng year thay thế
 *   - is_deleted       : kiểu boolean NULL [false] ← loại bỏ các bài viết đã bị xóa mềm (soft-deleted)
 *
 * growthRate so sánh số lượng bài báo theo publication_year: giữa currentYear và previousYear.
 */
const ARTICLES_STATS_QUERY = `
  MATCH (a:Article)
  WHERE coalesce(a.is_deleted, false) = false
  WITH
    count(a) AS totalValue,

    count(
      CASE
        WHEN a.publication_year IS NOT NULL
          AND toInteger(a.publication_year) = $currentYear
        THEN 1
      END
    ) AS currentCount,

    count(
      CASE
        WHEN a.publication_year IS NOT NULL
          AND toInteger(a.publication_year) = $previousYear
        THEN 1
      END
    ) AS previousCount

  RETURN totalValue, currentCount, previousCount
`;

/**
 * Tạp chí (Journals)
 *
 * Các trường lược đồ (schema) được sử dụng:
 *   - openalex_synced_at : kiểu timestamp NULL  ← mốc thời gian tốt nhất đại diện cho "created/updated"
 *   - is_deleted         : kiểu boolean [false] ← loại bỏ các tạp chí đã bị xóa mềm (soft-deleted)
 *
 * Không có trường created_at trên Journal → sử dụng openalex_synced_at làm mốc thay thế cho "dữ liệu thêm mới trong kỳ".
 */
const JOURNALS_STATS_QUERY = `
  MATCH (j:Journal)
  WHERE coalesce(j.is_deleted, false) = false
  WITH
    count(j) AS totalValue,

    count(
      CASE
        WHEN j.openalex_synced_at IS NOT NULL
          AND datetime(j.openalex_synced_at) >= datetime($currentStart)
          AND datetime(j.openalex_synced_at) <  datetime($currentEnd)
        THEN 1
      END
    ) AS currentCount,

    count(
      CASE
        WHEN j.openalex_synced_at IS NOT NULL
          AND datetime(j.openalex_synced_at) >= datetime($previousStart)
          AND datetime(j.openalex_synced_at) <  datetime($previousEnd)
        THEN 1
      END
    ) AS previousCount

  RETURN totalValue, currentCount, previousCount
`;

/**
 * Tác giả (Authors)
 *
 * Các trường lược đồ (schema) được sử dụng:
 *   - openalex_synced_at : kiểu timestamp NULL  ← mốc thời gian tốt nhất đại diện cho "created/updated"
 *   - is_deleted         : kiểu boolean [false] ← loại bỏ các tác giả đã bị xóa mềm (soft-deleted)
 *
 * Cấu trúc tương tự như Journal (không có trường created_at).
 */
const AUTHORS_STATS_QUERY = `
  MATCH (au:Author)
  WHERE coalesce(au.is_deleted, false) = false
  WITH
    count(au) AS totalValue,

    count(
      CASE
        WHEN au.openalex_synced_at IS NOT NULL
          AND datetime(au.openalex_synced_at) >= datetime($currentStart)
          AND datetime(au.openalex_synced_at) <  datetime($currentEnd)
        THEN 1
      END
    ) AS currentCount,

    count(
      CASE
        WHEN au.openalex_synced_at IS NOT NULL
          AND datetime(au.openalex_synced_at) >= datetime($previousStart)
          AND datetime(au.openalex_synced_at) <  datetime($previousEnd)
        THEN 1
      END
    ) AS previousCount

  RETURN totalValue, currentCount, previousCount
`;

/**
 * Trích dẫn (Citations - mối quan hệ :REFERENCES giữa các nút Article)
 *
 * Mối quan hệ REFERENCES mô phỏng lại cách sử dụng trong graph.service.js:
 *   (a:Article)-[r:REFERENCES]->(b:Article)
 *
 * growthRate: so sánh các lượt trích dẫn có nút nguồn (SOURCE article) có
 * publication_year khớp với năm/tháng hiện tại (current) so với trước đây (previous).
 *
 * Các trường lược đồ (schema) được sử dụng:
 *   - publication_year : kiểu integer NULL  (thuộc nút Article, được dùng làm mốc thay thế chu kỳ)
 *   - is_deleted       : kiểu boolean [false] trên cả hai nút đầu mút
 *
 * Lưu ý: Bản thân các mối quan hệ REFERENCES không mang thông tin mốc thời gian trong lược đồ,
 * do đó chúng tôi gom nhóm theo publication_year của bài báo nguồn (source article).
 * Đối với mức độ chi tiết theo tháng, chúng tôi sử dụng so sánh năm (currentYear so với previousYear).
 */
const CITATIONS_STATS_QUERY = `
  MATCH (a:Article)-[r:REFERENCES]->(b:Article)
  WHERE coalesce(a.is_deleted, false) = false
    AND coalesce(b.is_deleted, false) = false
  WITH
    count(r) AS totalValue,

    count(
      CASE
        WHEN a.publication_year IS NOT NULL
          AND toInteger(a.publication_year) = $currentYear
        THEN 1
      END
    ) AS currentCount,

    count(
      CASE
        WHEN a.publication_year IS NOT NULL
          AND toInteger(a.publication_year) = $previousYear
        THEN 1
      END
    ) AS previousCount

  RETURN totalValue, currentCount, previousCount
`;

// ─────────────────────────────────────────────────────────────────────────────
// HÀM DỊCH VỤ CHÍNH (MAIN SERVICE FUNCTION)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lấy số liệu thống kê dashboard từ Neo4j.
 *
 * Trả về tổng số tích lũy + tỷ lệ tăng trưởng (growthRate) theo tháng cho:
 *   Articles, Journals, Authors, Citations (mối quan hệ REFERENCES).
 *
 * Kết quả được lưu tạm trong Redis trong vòng CACHE_TTL giây (mặc định: 5 phút).
 *
 * @returns {Promise<DashboardStats>}
 */
export async function getDashboardStats() {
    // ── 1. Kiểm tra cache Redis (graceful fallback: Nếu Redis offline → bỏ qua, không gây crash ứng dụng) ──
    try {
        const cached = await redisGet(CACHE_KEY);
        if (cached) {
            return JSON.parse(cached); // Cache HIT → trả về kết quả ngay lập tức, không truy vấn Neo4j
        }
    } catch (redisErr) {
        // Redis offline hoặc lỗi mạng → bỏ qua cache, tiếp tục truy vấn cơ sở dữ liệu Neo4j
        console.warn('[Dashboard] Redis không khả dụng, bỏ qua việc đọc dữ liệu từ cache:', redisErr.message);
    }

    // ── 2. Kiểm tra cấu hình Neo4j driver ───────────────────────────────────────────────────
    const driver = neo4jDriver;
    if (!driver) {
        throw new Error(
            'Neo4j driver chưa được cấu hình. Vui lòng thiết lập các biến môi trường NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD.'
        );
    }

    // ── 3. Thiết lập các tham số chu kỳ thời gian ────────────────────────────────────────────────
    const {
        currentYear, previousYear,
        currentStart, currentEnd,
        previousStart, previousEnd,
    } = getPeriodBounds();

    const params = {
        currentStart, currentEnd,
        previousStart, previousEnd,
        currentYear, previousYear,
    };

    // ── 4. Thực thi tuần tự các truy vấn trên một session duy nhất ───────────────
    const session = driver.session({ defaultAccessMode: 'READ' });

    try {
        const articlesResult = await session.run(ARTICLES_STATS_QUERY, params);
        const journalsResult = await session.run(JOURNALS_STATS_QUERY, params);
        const authorsResult = await session.run(AUTHORS_STATS_QUERY, params);
        const citationsResult = await session.run(CITATIONS_STATS_QUERY, params);

        // ── 5. Phân tích cú pháp của từng kết quả trả về ─────────────────────────────────────────────────
        /**
         * Mỗi câu truy vấn trả về chính xác một bản ghi (record) chứa:
         *   totalValue, currentCount, previousCount
         */
        const parse = (result) => {
            const record = result.records[0];
            return {
                total: toSafeNumber(record?.get('totalValue')),
                current: toSafeNumber(record?.get('currentCount')),
                previous: toSafeNumber(record?.get('previousCount')),
            };
        };

        const articles = parse(articlesResult);
        const journals = parse(journalsResult);
        const authors = parse(authorsResult);
        const citations = parse(citationsResult);

        // ── 6. Tổng hợp cấu trúc dữ liệu phản hồi ──────────────────────────────────────────────────
        /** @type {DashboardStats} */
        const stats = {
            totalArticles: {
                value: articles.total,
                growthRate: calcGrowthRate(articles.current, articles.previous),
            },
            totalJournals: {
                value: journals.total,
                growthRate: calcGrowthRate(journals.current, journals.previous),
            },
            totalAuthors: {
                value: authors.total,
                growthRate: calcGrowthRate(authors.current, authors.previous),
            },
            totalCitations: {
                value: citations.total,
                growthRate: calcGrowthRate(citations.current, citations.previous),
            },
        };

        // ── 7. Lưu kết quả vào cache & trả về dữ liệu ─────────────────────────────────────────────────────
        // Xử lý lỗi an toàn (graceful fallback): Nếu Redis offline → bỏ qua ghi cache, không làm sập ứng dụng
        try {
            await redisSet(CACHE_KEY, JSON.stringify(stats), CACHE_TTL);
        } catch (redisErr) {
            console.warn('[Dashboard] Redis không khả dụng, bỏ qua việc ghi cache:', redisErr.message);
        }

        return stats;
    } finally {
        await session.close();
    }
}

/**
 * @typedef {Object} StatMetric
 * @property {number} value      - Tổng số lượng tích lũy trọn đời (tất cả các bản ghi).
 * @property {number} growthRate - Tỷ lệ tăng trưởng theo chu kỳ (%).
 */

/**
 * @typedef {Object} DashboardStats
 * @property {StatMetric} totalArticles
 * @property {StatMetric} totalJournals
 * @property {StatMetric} totalAuthors
 * @property {StatMetric} totalCitations
 */
