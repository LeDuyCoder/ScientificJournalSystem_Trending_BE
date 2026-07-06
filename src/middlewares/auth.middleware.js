import { AuthRequiredError, getAuthenticatedUserId } from '../utils/authToken.utils.js';
import logger from '../utils/logger.js';

export const requireAuth = (req, res, next) => {
  try {
    const { userId, payload } = getAuthenticatedUserId(req);

    req.user = {
      ...payload,
      user_id: userId,
      payload
    };

    next();
  } catch (error) {
    if (error instanceof AuthRequiredError || error?.code === 'AUTH_REQUIRED') {
      return res.status(401).json({
        success: false,
        message: 'Vui lòng đăng nhập để tiếp tục.'
      });
    }

    logger.error('[AUTH] Lỗi xác thực access_token:', error);
    return res.status(500).json({
      success: false,
      message: 'Đã xảy ra lỗi xác thực, vui lòng thử lại sau.'
    });
  }
};
