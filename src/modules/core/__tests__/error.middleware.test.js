import { describe, it, expect, vi, beforeEach } from 'vitest';
import { errorHandler } from '../error.middleware.js';

describe('Error Middleware', () => {
  let mockReq;
  let mockRes;
  let mockNext;

  beforeEach(() => {
    mockReq = {};
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    mockNext = vi.fn();
  });

  it('should return 500 and default message if no status or message is provided', () => {
    const error = new Error();
    
    errorHandler(error, mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith({
      message: 'Internal Server Error',
    });
  });

  it('should use statusCode and custom message if provided', () => {
    const error = new Error('Custom Error');
    error.statusCode = 400;

    errorHandler(error, mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      message: 'Custom Error',
    });
  });

  it('should fallback to status if statusCode is not provided', () => {
    const error = new Error('Not Found');
    error.status = 404;

    errorHandler(error, mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(404);
    expect(mockRes.json).toHaveBeenCalledWith({
      message: 'Not Found',
    });
  });
});
