import pool from '../config/database.js';
import logger from '../utils/logger.js';

/**
 * Middleware to ensure the authenticated user owns the project
 * they are trying to access.
 */
export const requireProjectAccess = async (req, res, next) => {
  try {
    const projectId = req.query?.project_id || req.params?.project_id || req.body?.project_id;
    const userId = req.user?.user_id;

    if (!projectId) {
      logger.info(`[AUTH] requireProjectAccess skipped. projectId is undefined.`);
      return next(); // Let the schema validator handle if project_id is missing
    }
    logger.info(`[AUTH] Checking access for projectId: ${projectId}, userId: ${userId}`);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Vui lòng đăng nhập để tiếp tục.'
      });
    }

    // Check if the project belongs to the user
    const query = `SELECT 1 FROM "Project" WHERE project_id = $1 AND user_id = $2 LIMIT 1`;
    const result = await pool.query(query, [projectId, userId]);

    if (result.rowCount === 0) {
      logger.warn(`User ${userId} attempted to access project ${projectId} without permission.`);
      return res.status(403).json({
        success: false,
        message: 'Bạn không có quyền truy cập vào project này.'
      });
    }

    next();
  } catch (error) {
    logger.error(`[AUTH] Lỗi kiểm tra quyền truy cập project (projectId: ${req.query?.project_id || req.params?.project_id || req.body?.project_id}):`, error);
    return res.status(500).json({
      success: false,
      message: 'Đã xảy ra lỗi kiểm tra quyền, vui lòng thử lại sau.'
    });
  }
};
