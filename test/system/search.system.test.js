import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import app from '../../src/app.js';
import * as searchService from '../../src/modules/search/services/search/search.service.js';

vi.mock('../../src/modules/search/services/search/search.service.js', () => ({
  searchEntities: vi.fn(),
}));

describe('Search System Tests (API)', () => {
  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /search', () => {
    it('should return 200 and search results', async () => {
      const mockData = { total: 1, items: [{ name: 'Test' }] };
      searchService.searchEntities.mockResolvedValue(mockData);

      const response = await app.inject({
        method: 'GET',
        url: '/search?q=Test',
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.code).toBe(200);
      expect(json.message).toBe('Fetch search results successfully');
      expect(json.data).toEqual(mockData);
    });
  });
});
