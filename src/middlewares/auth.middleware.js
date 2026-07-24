import { AuthRequiredError, getAuthenticatedUserId, extractAccessTokenFromRequest } from '../utils/authToken.utils.js';
import logger from '../utils/logger.js';

export const requireAuth = (req, res, next) => {
  try {
    console.log('[DEBUG AUTH] requireAuth headers:', JSON.stringify(req.headers));
    const token = extractAccessTokenFromRequest(req);
    console.log('[DEBUG AUTH] extracted token:', token);
    const { userId, payload } = getAuthenticatedUserId(req);
    console.log('[DEBUG AUTH] authenticated userId:', userId, 'payload:', JSON.stringify(payload));

    req.user = {
      ...payload,
      user_id: userId,
      payload
    };

    next();
  } catch (error) {
    console.error('[DEBUG AUTH] authentication catch error:', error);
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
