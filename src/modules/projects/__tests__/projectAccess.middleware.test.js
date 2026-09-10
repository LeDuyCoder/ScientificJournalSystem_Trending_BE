import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requireProjectAccess } from '../projectAccess.middleware.js';
import pool from '../../../config/database.js';
import logger from '../../../utils/logger.js';

vi.mock('../../../config/database.js', () => ({
  default: {
    query: vi.fn(),
  },
}));

vi.mock('../../../utils/logger.js', () => ({
  default: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Project Access Middleware', () => {
  let mockReq;
  let mockRes;

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockReq = {
      query: {},
      params: {},
      body: {},
      user: {
        user_id: 'user123',
      },
    };
    
    mockRes = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };
  });

  it('should skip auth check if no project ID is provided', async () => {
    await requireProjectAccess(mockReq, mockRes);
    expect(pool.query).not.toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it('should return 401 if user is not authenticated', async () => {
    mockReq.query.project_id = 'proj123';
    mockReq.user = null;

    await requireProjectAccess(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.send).toHaveBeenCalledWith({
      success: false,
      message: 'Vui lòng đăng nhập để tiếp tục.',
    });
  });

  it('should grant access if user is project owner or accepted member', async () => {
    mockReq.query.project_id = 'proj123';
    pool.query.mockResolvedValue({ rowCount: 1 });

    await requireProjectAccess(mockReq, mockRes);

    expect(pool.query).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it('should return 403 if user has no access', async () => {
    mockReq.query.project_id = 'proj123';
    pool.query.mockResolvedValue({ rowCount: 0 });

    await requireProjectAccess(mockReq, mockRes);

    expect(logger.warn).toHaveBeenCalled();
    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockRes.send).toHaveBeenCalledWith({
      success: false,
      message: 'Bạn không có quyền truy cập vào project này.',
    });
  });

  it('should return 500 on database error', async () => {
    mockReq.query.project_id = 'proj123';
    const dbError = new Error('Database connection failed');
    pool.query.mockRejectedValue(dbError);

    await requireProjectAccess(mockReq, mockRes);

    expect(logger.error).toHaveBeenCalled();
    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.send).toHaveBeenCalledWith({
      success: false,
      message: 'Đã xảy ra lỗi kiểm tra quyền, vui lòng thử lại sau.',
    });
  });
});
