import prisma from "./prisma.js";
import logger from "../utils/logger.js";
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

export const checkPostgres = async () => {
  try {
    await prisma.$queryRaw`SELECT NOW()`;
    logger.db(`Kết nối tới PostgreSQL (Prisma) thành công!`);
  } catch (err) {
    logger.error("Kết nối tới PostgreSQL thất bại!", err);
    throw err;
  }
};

// Shim for backward compatibility with existing pool.query(...) calls using pg module
prisma.query = async (sql, params = []) => {
  try {
    return await pool.query(sql, params);
  } catch (error) {
    logger.error('Error executing query via pg wrapper:', error);
    throw error;
  }
};

prisma.connect = async () => {
  return await pool.connect();
};

export default prisma;
