import pool from '../../config/database.js';
import logger from '../../utils/logger.js';

/**
 * Middleware to ensure the authenticated user has access to the project
 * they are trying to reach.
 *
 * Access is granted when the user satisfies ANY of the following:
 *   1. They are the **owner** of the project  (Project.user_id).
 *   2. They are an **accepted member**         (Project_Member.status = 'ACCEPTED').
 */
export const requireProjectAccess = async (req, res) => {
  try {
    const projectId = req.query.project_id || req.params.project_id || req.body.project_id;
    const userId = req.user?.user_id;

    if (!projectId || projectId === 'undefined' || projectId === 'null') {
      return; // Skip auth check if no project ID (or if it's string "undefined")
    }

    if (!userId) {
      return res.status(401).send({
        success: false,
        message: 'Vui lòng đăng nhập để tiếp tục.'
      });
    }

    // Check if the user is the project owner OR an accepted project member
    const query = `
      SELECT 1 FROM "Project"
        WHERE project_id = $1 AND user_id = $2
      UNION ALL
      SELECT 1 FROM "Project_Member"
        WHERE project_id = $1 AND user_id = $2 AND status = 'ACCEPTED'
      LIMIT 1
    `;
    const result = await pool.query(query, [projectId, userId]);

    if (result.rowCount === 0) {
      logger.warn(`User ${userId} attempted to access project ${projectId} without permission.`);
      return res.status(403).send({
        success: false,
        message: 'Bạn không có quyền truy cập vào project này.'
      });
    }

    return;
  } catch (error) {
    logger.error('[AUTH] Lỗi kiểm tra quyền truy cập project:', error);
    return res.status(500).send({
      success: false,
      message: 'Đã xảy ra lỗi kiểm tra quyền, vui lòng thử lại sau.'
    });
  }
};
