import { Meilisearch } from 'meilisearch';
import dotenv from 'dotenv';
import logger from '../utils/logger.js';

dotenv.config();

const MEILI_HOST = process.env.MEILI_HOST || 'http://127.0.0.1:7700';
const MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY || 'ABC123456';

export const meiliClient = new Meilisearch({
  host: MEILI_HOST,
  apiKey: MEILI_MASTER_KEY,
});

// Optionally, a helper to test connection
export const checkMeiliConnection = async () => {
  try {
    const health = await meiliClient.health();
    logger.info(`[Meilisearch] Connected successfully, status: ${health.status}`);
    return true;
  } catch (error) {
    logger.error('[Meilisearch] Connection failed:', error.message);
    return false;
  }
};
