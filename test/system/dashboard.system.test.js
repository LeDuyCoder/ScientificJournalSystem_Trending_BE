import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import app from '../../src/app.js';
import * as dashboardService from '../../src/modules/dashboard/services/dashboard/dashboard.service.js';

vi.mock('../../src/modules/dashboard/services/dashboard/dashboard.service.js', () => ({
  getDashboardStats: vi.fn(),
}));

describe('Dashboard System Tests (API)', () => {
  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /dashboard/stats', () => {
    it('should return 200 and dashboard stats', async () => {
      const mockData = { totalArticles: 100, totalJournals: 50 };
      dashboardService.getDashboardStats.mockResolvedValue(mockData);

      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/stats?project_id=123',
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.code).toBe(200);
      expect(json.message).toBe('Fetch dashboard statistics successfully');
      expect(json.data).toEqual(mockData);
    });
  });
});
