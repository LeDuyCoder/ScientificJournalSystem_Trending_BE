import pkg from "pg";
import dotenv from "dotenv";
import logger from "../../utils/logger.js";

dotenv.config();

const { Pool } = pkg;

// Kiểm tra xem database đang trỏ tới localhost/127.0.0.1 hay không (Local Development Mode).
// Mục đích: Tránh lỗi kết nối SSL khi chạy database PostgreSQL cục bộ (vì local thường không cài đặt SSL).
const isLocal = process.env.POSTGRES_URL && (process.env.POSTGRES_URL.includes("localhost") || process.env.POSTGRES_URL.includes("127.0.0.1"));

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,

  // Nếu là local DB thì tắt SSL, ngược lại (Supabase/Production) thì bật cấu hình rejectUnauthorized: false
  ssl: isLocal ? false : {
    rejectUnauthorized: false,
  },

  // Pool config
  max: 20, // Số lượng kết nối tối đa trong pool
  idleTimeoutMillis: 30000, // Đóng các kết nối không dùng sau 30 giây
  connectionTimeoutMillis: 10000, // Timeout kết nối
});

export const checkPostgres = async () => {
  try {
    const res = await pool.query('SELECT NOW()');
    logger.db(`Kết nối tới PostgreSQL thành công lúc: ${res.rows[0].now}`);
  } catch (err) {
    logger.error("Kết nối tới PostgreSQL thất bại!", err);
    throw err; // Ném lỗi để bootstrap function có thể bắt được
  }
};

export default pool;
