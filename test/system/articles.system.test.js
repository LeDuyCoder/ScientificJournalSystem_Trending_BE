import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import app from '../../src/app.js';
import * as graphService from '../../src/modules/search/services/search/graph.service.js';

vi.mock('../../src/modules/auth/auth.middleware.js', () => ({
  requireAuth: vi.fn(async (req, res, ...rest) => {
    req.user = { user_id: '123', role: 'STUDENT' };
    if (typeof rest[0] === 'function') rest[0]();
  }),
}));

vi.mock('../../src/modules/search/services/search/graph.service.js', () => ({
  searchArticlesByKeyword: vi.fn(),
}));

describe('Articles System Tests (API)', () => {
  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /articles/search', () => {
    it('should return 200 and search results', async () => {
      const mockData = { source: 'neo4j', nodes: [], relationships: [] };
      graphService.searchArticlesByKeyword.mockResolvedValue(mockData);

      const response = await app.inject({
        method: 'GET',
        url: '/articles/search?keyword=AI&limit=10',
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.code).toBe(200);
      expect(json.message).toBe('Search articles graph completed successfully');
      expect(json.data).toEqual(mockData);
    });
  });
});
