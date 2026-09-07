import pool from '../../config/database.js';
import logger from '../../utils/logger.js';

export async function getJobStatus(request, reply) {
  const { id } = request.params;
  
  try {
    const result = await pool.query(
      `SELECT job_id, job_type, status, progress, result, error, created_at, started_at, completed_at 
       FROM "analytics_job" 
       WHERE job_id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({
        success: false,
        message: 'Job not found'
      });
    }

    const job = result.rows[0];
    
    return reply.code(200).send({
      success: true,
      data: job
    });
  } catch (error) {
    logger.error(`Lỗi khi lấy trạng thái job ${id}:`, error);
    return reply.code(500).send({
      success: false,
      message: 'Lỗi server'
    });
  }
}
