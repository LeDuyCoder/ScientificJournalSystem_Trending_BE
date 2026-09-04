import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requireAuth } from '../auth.middleware.js';
import * as authTokenUtils from '../../../utils/authToken.utils.js';
import logger from '../../../utils/logger.js';

vi.mock('../../../utils/authToken.utils.js', () => ({
  AuthRequiredError: class AuthRequiredError extends Error {},
  extractAccessTokenFromRequest: vi.fn(),
  getAuthenticatedUserId: vi.fn(),
}));

vi.mock('../../../utils/logger.js', () => ({
  default: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

describe('Auth Middleware', () => {
  let mockReq;
  let mockRes;
  let mockNext;

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockReq = {
      headers: {},
      user: null,
    };
    
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    
    mockNext = vi.fn();
  });

  it('should call next and set req.user on successful authentication', () => {
    const mockToken = 'valid-token';
    const mockUserId = 'user123';
    const mockPayload = { role: 'admin' };

    authTokenUtils.extractAccessTokenFromRequest.mockReturnValue(mockToken);
    authTokenUtils.getAuthenticatedUserId.mockReturnValue({ userId: mockUserId, payload: mockPayload });

    requireAuth(mockReq, mockRes, mockNext);

    expect(authTokenUtils.extractAccessTokenFromRequest).toHaveBeenCalledWith(mockReq);
    expect(authTokenUtils.getAuthenticatedUserId).toHaveBeenCalledWith(mockReq);
    expect(mockReq.user).toEqual({
      ...mockPayload,
      user_id: mockUserId,
      payload: mockPayload,
    });
    expect(mockNext).toHaveBeenCalled();
  });

  it('should return 401 if AuthRequiredError is thrown', () => {
    const error = new authTokenUtils.AuthRequiredError('Auth required');
    authTokenUtils.extractAccessTokenFromRequest.mockImplementation(() => {
      throw error;
    });

    requireAuth(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.json).toHaveBeenCalledWith({
      success: false,
      message: 'Vui lòng đăng nhập để tiếp tục.',
    });
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 500 for other unexpected errors', () => {
    const error = new Error('Unexpected failure');
    authTokenUtils.extractAccessTokenFromRequest.mockImplementation(() => {
      throw error;
    });

    requireAuth(mockReq, mockRes, mockNext);

    expect(logger.error).toHaveBeenCalled();
    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith({
      success: false,
      message: 'Đã xảy ra lỗi xác thực, vui lòng thử lại sau.',
    });
    expect(mockNext).not.toHaveBeenCalled();
  });
});
