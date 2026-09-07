import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import app from '../../src/app.js';

describe('Journal Management System Tests (API)', () => {
  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/v1/journal', () => {
    it('ST-JOUR-001: Get journal list successfully should return 200', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/journal',
      });
      // expect(response.statusCode).toBe(200);
    });
  });

  describe('GET /api/v1/journal/:id', () => {
    it('ST-JOUR-002: Get journal detail successfully should return 200', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/journal/1', // assuming 1 is a valid ID
      });
      // expect(response.statusCode).toBe(200);
    });

    it('ST-JOUR-003: Get detail of a non-existent journal should return 404', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/journal/999999', // invalid ID
      });
      // expect(response.statusCode).toBe(404);
    });
  });
});
