import pool from '../../../../config/database.js';
import logger from '../../../../utils/logger.js';
import { redisGet, redisSet } from '../../../core/services/infrastructure/redis.service.js';
import { getProjectScope } from '../trends/forecast.service.js';

const CACHE_KEY_PREFIX = 'analytics:network:chord';
const CACHE_TTL = 43200; // 12 hours // 1 giờ

/**
 * Chuẩn bị và làm sạch keywords từ query string.
 * @param {string} keywords - Chuỗi keywords ngăn cách bởi dấu phẩy.
 * @returns {{list: string[], normalized: string}}
 * - `list`: một mảng các keyword đã được trim.
 * - `normalized`: một chuỗi các keyword đã được chuyển sang chữ thường, sắp xếp và nối lại, dùng để tạo cache key ổn định.
 * @returns {{list: string[], normalized: string}}
 */
function prepareKeywords(keywords) {
  if (!keywords) return { list: [], normalized: '' };
  const list = String(keywords).split(',').map(k => k.trim()).filter(Boolean);
  const normalized = [...list].map(s => s.toLowerCase()).sort().join(',');
  return { list, normalized };
}

/**
 * Lấy danh sách các article_id và publication_year đã được lọc theo scope và filter.
 *
 * Hàm này thực hiện 2 lớp lọc:
 * 1. **Lọc theo Project Scope**: Lấy tất cả các bài báo thuộc phạm vi theo dõi của project (dựa trên `subjectCategoryIds` HOẶC `keywordIds`).
 * 2. **Lọc theo Client Filters**: Áp dụng thêm các bộ lọc từ người dùng (`subject_area`, `keywords`, `from_year`, `to_year`)
 *    để làm hẹp kết quả trong phạm vi của project. Các bộ lọc này được kết hợp bằng điều kiện `AND`.
 *
 * @param {object} scope - Phạm vi theo dõi của project, chứa `subjectCategoryIds` và `keywordIds`.
 * @param {object} filters - Các bộ lọc từ client, chứa `subject_area`, `keywords`, `from_year`, `to_year`.
 * @param {import('pg').PoolClient} client - Đối tượng kết nối PostgreSQL.
 * @returns {Promise<Array<{article_id: number, publication_year: number}>>}
 */
async function getFilteredArticleIds(scope, filters, client) {
  const { subject_area, keywords, from_year, to_year } = filters;
  const { subjectCategoryIds, keywordIds } = scope;

  if (subjectCategoryIds.length === 0 && keywordIds.length === 0) {
    return [];
  }

  const cteParts = [];
  const params = [];

  // 1. Project Scope topics / keywords
  const scopeSelects = [];
  if (subjectCategoryIds.length > 0) {
    params.push(subjectCategoryIds);
    const catIdx = params.length;
    scopeSelects.push(`
      SELECT a.article_id
      FROM "Article" a
      JOIN "Topic" t ON a.primary_topic = t.topic_id
      WHERE t.subject_category_id = ANY($${catIdx}::bigint[]) AND COALESCE(a.is_deleted, false) = false
      UNION
      SELECT st.article_id
      FROM "Sub_Topic" st
      JOIN "Topic" t ON st.topic_id = t.topic_id
      WHERE t.subject_category_id = ANY($${catIdx}::bigint[])
    `);
  }
  if (keywordIds.length > 0) {
    params.push(keywordIds);
    const kwIdx = params.length;
    scopeSelects.push(`
      SELECT article_id
      FROM "Keyword_Article"
      WHERE keyword_id = ANY($${kwIdx}::bigint[])
    `);
  }
  cteParts.push(`project_scope AS (${scopeSelects.join(' UNION ')})`);

  // 2. Client filter: subject_area
  if (subject_area) {
    const saRes = await client.query(`SELECT subject_area_id FROM "Subject_Area" WHERE LOWER(display_name) = LOWER($1) AND COALESCE(is_deleted, false) = false`, [subject_area.trim()]);
    if (saRes.rows.length > 0) {
      const scRes = await client.query(`SELECT subject_category_id FROM "Subject_Category" WHERE subject_area_id = $1 AND COALESCE(is_deleted, false) = false`, [saRes.rows[0].subject_area_id]);
      const filterCategoryIds = scRes.rows.map(r => r.subject_category_id);
      if (filterCategoryIds.length > 0) {
        params.push(filterCategoryIds);
        const filterCatIdx = params.length;
        cteParts.push(`sa_filter AS (
          SELECT a.article_id FROM "Article" a
          JOIN "Topic" t ON a.primary_topic = t.topic_id
          WHERE t.subject_category_id = ANY($${filterCatIdx}::bigint[]) AND COALESCE(a.is_deleted, false) = false
          UNION
          SELECT st.article_id FROM "Sub_Topic" st
          JOIN "Topic" t ON st.topic_id = t.topic_id
          WHERE t.subject_category_id = ANY($${filterCatIdx}::bigint[])
        )`);
      } else return [];
    } else return [];
  }

  // 3. Client filter: keywords
  if (keywords && keywords.list && keywords.list.length > 0) {
    const kwRes = await client.query(`SELECT keyword_id FROM "Keyword" WHERE LOWER(display_name) = ANY($1::text[])`, [keywords.list.map(k => k.toLowerCase())]);
    const filterKeywordIds = kwRes.rows.map(r => r.keyword_id);
    if (filterKeywordIds.length > 0) {
      params.push(filterKeywordIds);
      const filterKwIdx = params.length;
      cteParts.push(`kw_filter AS (
        SELECT article_id FROM "Keyword_Article" WHERE keyword_id = ANY($${filterKwIdx}::bigint[])
      )`);
    } else return [];
  }

  // 4. Combine into filtered_articles
  const joinClauses = ['JOIN project_scope ps ON a.article_id = ps.article_id'];
  if (subject_area) {
    joinClauses.push('JOIN sa_filter saf ON a.article_id = saf.article_id');
  }
  if (keywords && keywords.list && keywords.list.length > 0) {
    joinClauses.push('JOIN kw_filter kwf ON a.article_id = kwf.article_id');
  }

  const yearFilters = [];
  if (from_year) {
    params.push(Number(from_year));
    yearFilters.push(`a.publication_year >= $${params.length}`);
  }
  if (to_year) {
    params.push(Number(to_year));
    yearFilters.push(`a.publication_year <= $${params.length}`);
  }
  const yearWhere = yearFilters.length > 0 ? `AND ${yearFilters.join(' AND ')}` : '';

  const query = `
    WITH ${cteParts.join(', ')}
    SELECT a.article_id, a.publication_year
    FROM "Article" a
    ${joinClauses.join(' ')}
    WHERE COALESCE(a.is_deleted, false) = false ${yearWhere}
  `;

  const result = await client.query(query, params);
  return result.rows;
}

/**
 * Lấy danh sách các quốc gia cho mỗi bài báo.
 *
 * Luồng query: Article -> Author_Article -> Institution_Author -> Institution -> Zone (Country).
 * - Chỉ lấy các quốc gia hợp lệ (`z.type = 'COUNTRY'`).
 * - Sử dụng `UPPER(z.name)` để chuẩn hóa tên quốc gia.
 * - Điều kiện `ia.year = a.publication_year` đảm bảo chỉ lấy affiliation của tác giả tại năm bài báo được xuất bản.
 * @param {Array<{article_id: number, publication_year: number}>} articles - Mảng các bài báo cần lấy thông tin quốc gia.
 * @param {import('pg').PoolClient} client - Đối tượng kết nối PostgreSQL.
 * @returns {Promise<Map<number, Set<string>>>} Một Map với key là `article_id` và value là một `Set` chứa các tên quốc gia (đã uppercase).
 */
async function getCountriesByArticles(articles, client) {
  if (articles.length === 0) return new Map();

  const articleIds = articles.map(a => a.article_id);
  const articleYearMap = new Map(articles.map(a => [a.article_id, a.publication_year]));

  // Join `Institution_Author.institution_id`
  // và `ia.year = (subquery)` để đảm bảo tính chính xác về thời gian.
  const query = `
    SELECT DISTINCT
      aa.article_id,
      UPPER(z.name) AS country_name
    FROM "Author_Article" aa
    JOIN "Institution_Author" ia ON ia.author_id = aa.author_id
    JOIN "Institution" ins ON ins.institution_id = ia.institution_id
    JOIN "Zone" z ON z.code = ins.country_code
    WHERE aa.article_id = ANY($1::bigint[])
      AND z.type = 'COUNTRY'
      AND ins.country_code IS NOT NULL
      AND z.name IS NOT NULL
      AND ia.year = (
        SELECT publication_year FROM "Article" WHERE article_id = aa.article_id
      )
  `;

  const result = await client.query(query, [articleIds]);

  const countriesByArticle = new Map();
  for (const row of result.rows) {
    if (!countriesByArticle.has(row.article_id)) {
      countriesByArticle.set(row.article_id, new Set());
    }
    countriesByArticle.get(row.article_id).add(row.country_name);
  }

  return countriesByArticle;
}

/**
 * Xây dựng các cặp quốc gia và tính toán coAuthorshipValue.
 * Hàm này duyệt qua từng bài báo, nếu bài báo có từ 2 quốc gia trở lên, nó sẽ tạo ra tất cả các cặp kết hợp có thể có.
 *
 * Ví dụ: Article A có {USA, CHINA, JAPAN} -> tạo ra 3 cặp: (CHINA, JAPAN), (CHINA, USA), (JAPAN, USA).
 * Mỗi cặp được tính là 1 lần hợp tác cho bài báo đó.
 *
 * @param {Map<number, Set<string>>} countriesByArticle - Map chứa danh sách quốc gia theo từng bài báo.
 * @returns {Array<{source: string, target: string, coAuthorshipValue: number}>} Mảng các đối tượng cặp quốc gia và số lần hợp tác.
 */
function buildCountryPairs(countriesByArticle) {
  const pairCounts = new Map();

  for (const countries of countriesByArticle.values()) {
    if (countries.size < 2) continue;

    const countryList = Array.from(countries);
    for (let i = 0; i < countryList.length; i++) {
      for (let j = i + 1; j < countryList.length; j++) {
        // Sắp xếp theo alphabet để tạo key chuẩn hóa, tránh cặp (A,B) và (B,A) bị coi là khác nhau.
        const [source, target] = [countryList[i], countryList[j]].sort();
        const key = `${source}__${target}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }
  }

  return Array.from(pairCounts.entries()).map(([key, value]) => {
    const [source, target] = key.split('__');
    return { source, target, coAuthorshipValue: value };
  });
}

/**
 * Áp dụng các giới hạn về số lượng quốc gia và giá trị tối thiểu.
 * Logic này giúp biểu đồ Chord không bị quá rối và chỉ tập trung vào các mối quan hệ hợp tác quan trọng nhất.
 *
 * 1. Tính "sức mạnh hợp tác" (tổng `coAuthorshipValue`) cho mỗi quốc gia.
 * 2. Chọn ra `limitCountries` quốc gia có sức mạnh lớn nhất.
 * 3. Lọc danh sách các cặp, chỉ giữ lại những cặp mà CẢ HAI quốc gia đều nằm trong top đã chọn.
 * 4. Lọc tiếp, loại bỏ những cặp có `coAuthorshipValue` nhỏ hơn `minValue`.
 * 5. Sắp xếp kết quả cuối cùng theo `coAuthorshipValue` giảm dần.
 *
 * @param {Array<object>} pairs - Mảng các cặp quốc gia đã được tổng hợp.
 * @param {number} limitCountries - Số lượng quốc gia hàng đầu tối đa để hiển thị.
 * @param {number} minValue - Giá trị `coAuthorshipValue` tối thiểu để một cặp được tính.
 * @returns {Array<object>} Mảng các cặp quốc gia đã được lọc và sắp xếp.
 */
function applyChordLimits(pairs, limitCountries, minValue) {
  if (pairs.length === 0) return [];

  // 1. Tính tổng strength của mỗi quốc gia
  const countryStrength = new Map();
  pairs.forEach(({ source, target, coAuthorshipValue }) => {
    countryStrength.set(source, (countryStrength.get(source) || 0) + coAuthorshipValue);
    countryStrength.set(target, (countryStrength.get(target) || 0) + coAuthorshipValue);
  });

  // 2. Chọn top N quốc gia
  const topCountries = new Set(
    Array.from(countryStrength.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limitCountries)
      .map(entry => entry[0])
  );

  // 3 & 4. Lọc các cặp và áp dụng min_value
  const filteredPairs = pairs.filter(p =>
    p.coAuthorshipValue >= minValue &&
    topCountries.has(p.source) &&
    topCountries.has(p.target)
  );

  // 5. Sắp xếp kết quả cuối cùng
  return filteredPairs.sort((a, b) => b.coAuthorshipValue - a.coAuthorshipValue);
}

/**
 * Lấy dữ liệu hợp tác quốc gia cho biểu đồ chord.
 * Đây là hàm chính, điều phối toàn bộ logic:
 *
 * 1. **Kiểm tra Cache**: Tạo cache key và thử lấy dữ liệu từ Redis. Nếu có, trả về ngay.
 * 2. **Lấy Project Scope**: Xác định phạm vi bài báo cần phân tích dựa trên `project_id`.
 * 3. **Lọc Bài Báo**: Lấy danh sách các bài báo thỏa mãn cả scope và bộ lọc của người dùng.
 * 4. **Lấy Quốc Gia**: Từ danh sách bài báo, truy vấn để lấy các quốc gia liên quan.
 * 5. **Xây Dựng Cặp**: Tạo các cặp hợp tác và đếm số lần xuất hiện.
 * 6. **Áp Dụng Giới Hạn**: Lọc và giới hạn các cặp để phù hợp với biểu đồ.
 * 7. **Lưu Cache và Trả Về**: Lưu kết quả cuối cùng vào Redis và trả về cho client.
 *
 * @param {object} filters - Các tham số query đã được controller validate.
 * @returns {Promise<Array<object>>}
 */
export async function getCountryCollaborationChord(filters) {
  const { project_id, subject_area, keywords, from_year, to_year, limit_countries, min_value } = filters;

  const limitCountries = limit_countries !== undefined && limit_countries !== null ? Number(limit_countries) : 10;
  const minValue = min_value !== undefined && min_value !== null ? Number(min_value) : 1;

  const preparedKeywords = prepareKeywords(keywords);

  const cacheKey = `${CACHE_KEY_PREFIX}:${project_id}:${(subject_area || '').toLowerCase()}:${preparedKeywords.normalized}:${from_year || ''}:${to_year || ''}:${limitCountries}:${minValue}`;
  // --- Bắt đầu logic Cache ---

  try {
    const cachedData = await redisGet(cacheKey);
    if (cachedData) {
      logger.info(`[Redis] Cache hit for country collaboration chord: ${cacheKey}`);
      return JSON.parse(cachedData);
    }
  } catch (err) {
    logger.warn('Failed to get country collaboration from Redis, querying database:', err?.message || err);
  }

  // --- Kết thúc logic Cache ---

  const client = await pool.connect();
  try {
    // B1: Lấy scope của project (các category và keyword project theo dõi)
    const scope = await getProjectScope(client, project_id);

    if (scope.subjectCategoryIds.length === 0 && scope.keywordIds.length === 0) {
      logger.warn(`Project ${project_id} has no tracking scope. Returning empty chord data.`);
      return [];
    }

    // B2: Lấy danh sách các bài báo phù hợp với scope và bộ lọc
    const articles = await getFilteredArticleIds(scope, { subject_area, keywords: preparedKeywords, from_year, to_year }, client);
    if (articles.length === 0) {
      return [];
    }

    // B2.1: Tính toán growth YoY
    let prevPairMap = new Map();
    const fromYearNum = from_year ? Number(from_year) : undefined;
    const toYearNum = to_year ? Number(to_year) : undefined;
    if (fromYearNum && toYearNum) {
      const duration = toYearNum - fromYearNum + 1;
      const prevFromYear = fromYearNum - duration;
      const prevToYear = fromYearNum - 1;
      const prevArticles = await getFilteredArticleIds(scope, { subject_area, keywords: preparedKeywords, from_year: prevFromYear, to_year: prevToYear }, client);
      if (prevArticles.length > 0) {
        const prevCountriesByArticle = await getCountriesByArticles(prevArticles, client);
        const prevPairs = buildCountryPairs(prevCountriesByArticle);
        prevPairs.forEach(p => {
          prevPairMap.set(`${p.source}__${p.target}`, p.coAuthorshipValue);
        });
      }
    }

    // B3: Từ các bài báo, lấy ra danh sách các quốc gia hợp tác
    const countriesByArticle = await getCountriesByArticles(articles, client);
    if (countriesByArticle.size === 0) {
      return [];
    }

    // B4: Xây dựng các cặp quốc gia và đếm số lần hợp tác
    const allPairs = buildCountryPairs(countriesByArticle);

    // B5: Áp dụng các giới hạn (top N quốc gia, giá trị tối thiểu) để làm sạch dữ liệu cho biểu đồ
    const finalData = applyChordLimits(allPairs, limitCountries, minValue);

    // B5.1: Ánh xạ thêm thông tin growth
    const finalDataWithGrowth = finalData.map(pair => {
      const key = `${pair.source}__${pair.target}`;
      const prevVal = prevPairMap.get(key) || 0;
      let growthVal = 0;
      if (prevVal === 0) {
        growthVal = pair.coAuthorshipValue > 0 ? 100 : 0;
      } else {
        growthVal = Math.round(((pair.coAuthorshipValue - prevVal) / prevVal) * 100);
      }
      return {
        ...pair,
        growth: growthVal >= 0 ? `+${growthVal}%` : `${growthVal}%`
      };
    });

    // B6: Lưu kết quả vào cache cho các lần gọi sau
    try {
      await redisSet(cacheKey, JSON.stringify(finalDataWithGrowth), CACHE_TTL);
      logger.info(`[Redis] Country collaboration chord cached: ${cacheKey}`);
    } catch (err) {
      logger.warn('Failed to set country collaboration in Redis cache:', err?.message || err);
    }

    return finalDataWithGrowth;
  } finally {
    client.release();
  }
}