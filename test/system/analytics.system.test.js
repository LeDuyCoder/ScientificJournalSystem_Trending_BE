import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import app from '../../src/app.js';
import * as trendsService from '../../src/modules/analytics/services/trends/trends.service.js';
import * as frontierService from '../../src/modules/analytics/services/trends/frontier.service.js';
import * as distributionService from '../../src/modules/analytics/services/trends/distribution.service.js';
import * as forecastService from '../../src/modules/analytics/services/trends/forecast.service.js';

// Mock the services
vi.mock('../../src/modules/auth/auth.middleware.js', () => ({
  requireAuth: vi.fn(async (req, res, ...rest) => {
    req.user = { user_id: '123', role: 'STUDENT' };
    if (typeof rest[0] === 'function') rest[0]();
  }),
}));

vi.mock('../../src/modules/analytics/services/trends/trends.service.js', () => ({
  getPublicationTrends: vi.fn(),
}));

vi.mock('../../src/modules/analytics/services/trends/frontier.service.js', () => ({
  getFrontierTopics: vi.fn(),
}));

vi.mock('../../src/modules/analytics/services/trends/distribution.service.js', () => ({
  getDistribution: vi.fn(),
}));

vi.mock('../../src/modules/analytics/services/trends/forecast.service.js', () => ({
  getForecastInsights: vi.fn(),
}));

describe('Analytics System Tests (API)', () => {
  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /analytics/trends', () => {
    it('should return 200 and data when valid parameters are provided', async () => {
      const mockData = { timeline: [2020, 2021], series: [10, 20] };
      trendsService.getPublicationTrends.mockResolvedValue(mockData);

      const response = await app.inject({
        method: 'GET',
        url: '/analytics/trends?project_id=123',
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.code).toBe(200);
      expect(json.message).toBe('Fetch publication trends successfully');
      expect(json.data).toEqual(mockData);
    });
  });

  describe('GET /analytics/frontier', () => {
    it('should return 200 and frontier data', async () => {
      const mockData = [{ topic: 'Quantum Computing', impact: 8.5 }];
      frontierService.getFrontierTopics.mockResolvedValue(mockData);

      const response = await app.inject({
        method: 'GET',
        url: '/analytics/frontier?limit=5',
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.code).toBe(200);
      expect(json.data).toEqual(mockData);
    });
  });

  describe('GET /analytics/distribution', () => {
    it('should return 200 and distribution data', async () => {
      const mockData = { items: [] };
      distributionService.getDistribution.mockResolvedValue(mockData);

      const response = await app.inject({
        method: 'GET',
        url: '/analytics/distribution?project_id=123',
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.code).toBe(200);
      expect(json.message).toBe('Fetch distribution successfully');
      expect(json.data).toEqual(mockData);
    });
  });

  describe('GET /analytics/forecast', () => {
    it('should return 200 and forecast insights', async () => {
      const mockData = { peak: [], alert: [] };
      forecastService.getForecastInsights.mockResolvedValue(mockData);

      const response = await app.inject({
        method: 'GET',
        url: '/analytics/forecast?project_id=123',
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.code).toBe(200);
      expect(json.message).toBe('Fetch forecast insights successfully');
      expect(json.data).toEqual(mockData);
    });
  });
});
