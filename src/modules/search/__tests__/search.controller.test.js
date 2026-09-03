import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchEntitiesHandler } from '../search.controller.js';
import * as searchService from '../services/search/search.service.js';

vi.mock('../services/search/search.service.js', () => ({
  searchEntities: vi.fn(),
}));

describe('Search Controller', () => {
  let mockRequest;
  let mockReply;

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockRequest = {
      query: { q: 'test', type: 'all' },
    };

    mockReply = {
      send: vi.fn(),
      status: vi.fn().mockReturnThis(),
    };
  });

  describe('searchEntitiesHandler', () => {
    it('should search entities successfully', async () => {
      const mockData = { total: 1, items: [] };
      searchService.searchEntities.mockResolvedValue(mockData);

      await searchEntitiesHandler(mockRequest, mockReply);

      expect(searchService.searchEntities).toHaveBeenCalledWith(mockRequest.query);
      expect(mockReply.status).toHaveBeenCalledWith(200);
      expect(mockReply.send).toHaveBeenCalledWith({
        code: 200,
        message: 'Fetch search results successfully',
        data: mockData,
      });
    });

    it('should handle custom error from service', async () => {
      const error = new Error('Invalid query');
      error.status = 400;
      searchService.searchEntities.mockRejectedValue(error);

      await searchEntitiesHandler(mockRequest, mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(400);
      expect(mockReply.send).toHaveBeenCalledWith({
        code: 400,
        message: 'Invalid query',
        data: null,
      });
    });

    it('should throw 500 error', async () => {
      const error = new Error('Server error');
      searchService.searchEntities.mockRejectedValue(error);

      await expect(searchEntitiesHandler(mockRequest, mockReply)).rejects.toThrow('Server error');
    });
  });
});
