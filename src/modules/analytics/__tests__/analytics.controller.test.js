import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchTrends, fetchFrontier, fetchDistribution, fetchForecast } from '../analytics.controller.js';
import * as trendsService from '../services/trends/trends.service.js';
import * as frontierService from '../services/trends/frontier.service.js';
import * as distributionService from '../services/trends/distribution.service.js';
import * as forecastService from '../services/trends/forecast.service.js';

// Mock the service dependencies
vi.mock('../services/trends/trends.service.js', () => ({
  getPublicationTrends: vi.fn(),
}));

vi.mock('../services/trends/frontier.service.js', () => ({
  getFrontierTopics: vi.fn(),
}));

vi.mock('../services/trends/distribution.service.js', () => ({
  getDistribution: vi.fn(),
}));

vi.mock('../services/trends/forecast.service.js', () => ({
  getForecastInsights: vi.fn(),
}));

describe('Analytics Controller', () => {
  let mockRequest;
  let mockReply;

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockRequest = {
      query: {},
      body: {},
      params: {},
    };

    mockReply = {
      send: vi.fn(),
      status: vi.fn().mockReturnThis(),
    };
  });

  describe('fetchTrends', () => {
    it('should fetch publication trends successfully', async () => {
      const mockData = { timeline: [], series: [] };
      trendsService.getPublicationTrends.mockResolvedValue(mockData);

      mockRequest.query = { project_id: '123' };

      await fetchTrends(mockRequest, mockReply);

      expect(trendsService.getPublicationTrends).toHaveBeenCalledWith({ project_id: '123' });
      expect(mockReply.send).toHaveBeenCalledWith({
        code: 200,
        message: 'Fetch publication trends successfully',
        data: mockData,
      });
    });

    it('should throw an error if service fails', async () => {
      const mockError = new Error('Service failed');
      trendsService.getPublicationTrends.mockRejectedValue(mockError);

      await expect(fetchTrends(mockRequest, mockReply)).rejects.toThrow('Service failed');
    });
  });

  describe('fetchFrontier', () => {
    it('should fetch frontier topics successfully', async () => {
      const mockData = [{ topic: 'AI', impact: 10, velocity: 5 }];
      frontierService.getFrontierTopics.mockResolvedValue(mockData);

      mockRequest.query = { limit: 10 };

      await fetchFrontier(mockRequest, mockReply);

      expect(frontierService.getFrontierTopics).toHaveBeenCalledWith({ limit: 10 });
      expect(mockReply.send).toHaveBeenCalledWith({
        code: 200,
        message: 'Fetch frontier topics successfully',
        data: mockData,
      });
    });

    it('should throw an error if service fails', async () => {
      const mockError = new Error('Database error');
      frontierService.getFrontierTopics.mockRejectedValue(mockError);

      await expect(fetchFrontier(mockRequest, mockReply)).rejects.toThrow('Database error');
    });
  });

  describe('fetchDistribution', () => {
    it('should fetch distribution successfully', async () => {
      const mockData = { items: [] };
      distributionService.getDistribution.mockResolvedValue(mockData);
      mockRequest.query = { project_id: '123' };

      await fetchDistribution(mockRequest, mockReply);

      expect(distributionService.getDistribution).toHaveBeenCalledWith({
        project_id: '123',
        distribution_type: undefined,
        subject_area: undefined,
        keywords: undefined,
        from_year: undefined,
        to_year: undefined,
      });
      expect(mockReply.send).toHaveBeenCalledWith({
        code: 200,
        message: 'Fetch distribution successfully',
        data: mockData,
      });
    });

    it('should handle 404 error from service', async () => {
      const mockError = new Error('Not found');
      mockError.status = 404;
      distributionService.getDistribution.mockRejectedValue(mockError);

      await fetchDistribution(mockRequest, mockReply);
      
      expect(mockReply.status).toHaveBeenCalledWith(404);
      expect(mockReply.send).toHaveBeenCalledWith({
        code: 404,
        message: 'Not found',
        data: null,
      });
    });
  });

  describe('fetchForecast', () => {
    it('should fetch forecast successfully', async () => {
      const mockData = { peak: [], alert: [] };
      forecastService.getForecastInsights.mockResolvedValue(mockData);
      mockRequest.query = { project_id: '123' };

      await fetchForecast(mockRequest, mockReply);

      expect(forecastService.getForecastInsights).toHaveBeenCalledWith('123');
      expect(mockReply.send).toHaveBeenCalledWith({
        code: 200,
        message: 'Fetch forecast insights successfully',
        data: mockData,
      });
    });

    it('should handle custom error code from service', async () => {
      const mockError = new Error('Bad request');
      mockError.code = 400;
      forecastService.getForecastInsights.mockRejectedValue(mockError);

      await fetchForecast(mockRequest, mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(400);
      expect(mockReply.send).toHaveBeenCalledWith({
        code: 400,
        message: 'Bad request',
        data: null,
      });
    });
  });
});
