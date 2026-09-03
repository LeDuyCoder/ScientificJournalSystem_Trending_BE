import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDashboardStatsHandler } from '../dashboard.controller.js';
import * as dashboardService from '../services/dashboard/dashboard.service.js';

vi.mock('../services/dashboard/dashboard.service.js', () => ({
  getDashboardStats: vi.fn(),
}));

describe('Dashboard Controller', () => {
  let mockRequest;
  let mockReply;

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockRequest = {
      query: {},
    };

    mockReply = {
      send: vi.fn(),
      status: vi.fn().mockReturnThis(),
    };
  });

  describe('getDashboardStatsHandler', () => {
    it('should fetch dashboard stats successfully', async () => {
      const mockData = { totalArticles: 100, totalJournals: 50 };
      dashboardService.getDashboardStats.mockResolvedValue(mockData);
      
      mockRequest.query = { project_id: '123' };

      await getDashboardStatsHandler(mockRequest, mockReply);

      expect(dashboardService.getDashboardStats).toHaveBeenCalledWith({ projectId: 123n });
      expect(mockReply.status).toHaveBeenCalledWith(200);
      expect(mockReply.send).toHaveBeenCalledWith({
        code: 200,
        message: 'Fetch dashboard statistics successfully',
        data: mockData,
      });
    });

    it('should throw error if service fails', async () => {
      const error = new Error('Service error');
      dashboardService.getDashboardStats.mockRejectedValue(error);

      await expect(getDashboardStatsHandler(mockRequest, mockReply)).rejects.toThrow('Service error');
    });
  });
});
