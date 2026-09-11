import { AuthRequiredError, getAuthenticatedUserId, extractAccessTokenFromRequest } from '../../utils/authToken.utils.js';
import logger from '../../utils/logger.js';
import prisma from '../../config/prisma.js';

const sendAuthResponse = (res, statusCode, payload) => {
  if (res && typeof res.status === 'function') {
    if (typeof res.send === 'function') {
      return res.status(statusCode).send(payload);
    } else if (typeof res.json === 'function') {
      return res.status(statusCode).json(payload);
    }
  } else if (res && typeof res.code === 'function') {
    if (typeof res.send === 'function') {
      return res.code(statusCode).send(payload);
    }
  }
  return payload;
};

export const requireAuth = async (req, res, ...rest) => {
  const next = typeof rest[0] === 'function' ? rest[0] : null;
  try {
    // If request already authenticated by prior hook, proceed
    if (req.user && req.user.user_id) {
      if (next) next();
      return;
    }

    const token = extractAccessTokenFromRequest(req);
    if (!token) {
      throw new AuthRequiredError();
    }

    const { userId, payload } = getAuthenticatedUserId(req);

    // Verify account status in database if available
    let dbUser = null;
    try {
      if (prisma?.user?.findUnique) {
        dbUser = await prisma.user.findUnique({
          where: { user_id: userId },
          select: {
            user_id: true,
            email: true,
            role: true,
            status: true,
            first_name: true,
            last_name: true
          }
        });

        if (dbUser && dbUser.status === 'BANNED') {
          return sendAuthResponse(res, 403, {
            success: false,
            message: 'Tài khoản của bạn đã bị khóa.'
          });
        }
      }
    } catch (dbError) {
      logger.warn('[AUTH] Không thể kiểm tra database account, tiếp tục với token payload:', dbError.message);
    }

    req.user = {
      ...payload,
      ...(dbUser || {}),
      user_id: userId,
      payload
    };

    if (next) {
      next();
    }
    return;
  } catch (error) {
    if (error instanceof AuthRequiredError || error?.code === 'AUTH_REQUIRED') {
      return sendAuthResponse(res, 401, {
        success: false,
        message: 'Vui lòng đăng nhập để tiếp tục.'
      });
    }

    logger.error('[AUTH] Lỗi xác thực access_token:', error);
    return sendAuthResponse(res, 500, {
      success: false,
      message: 'Đã xảy ra lỗi xác thực, vui lòng thử lại sau.'
    });
  }
};


