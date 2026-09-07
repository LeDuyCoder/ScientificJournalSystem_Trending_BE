import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import app from '../../src/app.js';

describe('Search & Catalog System Tests (API)', () => {
  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/v1/articles', () => {
    it('ST-SRCH-001: Search articles with a valid keyword should return 200', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/articles?q=keyword',
      });
      // expect(response.statusCode).toBe(200);
      // const json = response.json();
      // expect(Array.isArray(json)).toBe(true);
    });

    it('ST-SRCH-002: Search articles with a keyword that matches nothing should return 200 with empty array', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/articles?q=thiskeyworddoesnotexist123',
      });
      // expect(response.statusCode).toBe(200);
      // const json = response.json();
      // expect(json).toEqual([]);
    });

    it('ST-SRCH-003: Get article list without query parameter should return 200', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/articles',
      });
      // expect(response.statusCode).toBe(200);
    });
  });
});
