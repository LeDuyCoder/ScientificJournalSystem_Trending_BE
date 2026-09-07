import { Worker } from 'bullmq';
import pool from '../config/database.js';
import logger from '../utils/logger.js';
import Redis from 'ioredis';

import { getCollaborationNetwork } from '../modules/analytics/services/collaboration/network.service.js';
import { getNetworkTopology } from '../modules/analytics/services/collaboration/topology.service.js';
import { getCollaborationInsights } from '../modules/analytics/services/collaboration/collabInsights.service.js';
import { getImpactMatrixData } from '../modules/analytics/services/metrics/impactMatrix.service.js';
import { getInfluentialRankings } from '../modules/analytics/services/metrics/rankings.service.js';
import { getKeywordVectors } from '../modules/analytics/services/trends/keywordVectors.service.js';


// Setup connection from redis client
const connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: null });

/**
 * Worker xử lý các job phân tích chuyên sâu (Network, Topology, Matrix)
 */
export const analyticsWorker = new Worker(
  'analytics-queue',
  async (job) => {
    logger.info(`Đang xử lý Job ID: ${job.id} - Type: ${job.name}`);
    
    const { query } = job.data;
    
    // Cập nhật trạng thái Job trong DB thành PROCESSING
    await pool.query(
      `UPDATE "analytics_job" SET status = 'PROCESSING', started_at = NOW() WHERE job_id = $1`,
      [job.id]
    );

    let result = null;

    try {
      switch(job.name) {
        case 'network-analysis':
          result = await getCollaborationNetwork(query);
          break;
        case 'topology-analysis':
          result = await getNetworkTopology(query);
          break;
        case 'collab-insights':
          result = await getCollaborationInsights(query);
          break;
        case 'impact-matrix':
          result = await getImpactMatrixData(query);
          break;
        case 'rankings':
          result = await getInfluentialRankings(query);
          break;
        case 'keyword-vectors':
          result = await getKeywordVectors(query);
          break;
        default:
          throw new Error(`Loại job không được hỗ trợ: ${job.name}`);
      }

      // Lưu kết quả thành công
      await pool.query(
        `UPDATE "analytics_job" 
         SET status = 'COMPLETED', result = $1, completed_at = NOW() 
         WHERE job_id = $2`,
        [JSON.stringify(result), job.id]
      );

      
      logger.info(`Job ID: ${job.id} hoàn thành thành công.`);
      return result;
    } catch (error) {
      logger.error(`Lỗi khi xử lý Job ID: ${job.id}`, error);
      
      // Lưu kết quả lỗi
      await pool.query(
        `UPDATE "analytics_job" 
         SET status = 'ERROR', error = $1, completed_at = NOW() 
         WHERE job_id = $2`,
        [error.message, job.id]
      );
      
      throw error;
    }
  },
  {
    connection,
    concurrency: 2, // Xử lý đồng thời 2 job nặng
  }
);

analyticsWorker.on('completed', (job) => {
  logger.info(`[BullMQ] Job ${job.id} has completed!`);
});

analyticsWorker.on('failed', (job, err) => {
  logger.error(`[BullMQ] Job ${job.id} has failed with ${err.message}`);
});
