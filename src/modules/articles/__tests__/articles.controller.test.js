import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchArticles } from '../articles.controller.js';
import * as graphService from '../../search/services/search/graph.service.js';

vi.mock('../../search/services/search/graph.service.js', () => ({
  searchArticlesByKeyword: vi.fn(),
}));

describe('Articles Controller', () => {
  let mockRequest;
  let mockReply;

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockRequest = {
      query: {},
    };

    mockReply = {
      send: vi.fn(),
    };
  });

  describe('searchArticles', () => {
    it('should search articles successfully', async () => {
      const mockData = { source: 'neo4j', nodes: [], relationships: [] };
      graphService.searchArticlesByKeyword.mockResolvedValue(mockData);

      mockRequest.query = { keyword: 'AI', limit: 10 };

      await searchArticles(mockRequest, mockReply);

      expect(graphService.searchArticlesByKeyword).toHaveBeenCalledWith('AI', { limit: 10 });
      expect(mockReply.send).toHaveBeenCalledWith({
        code: 200,
        message: 'Search articles graph completed successfully',
        data: mockData,
      });
    });

    it('should throw error if service fails', async () => {
      const error = new Error('Database error');
      graphService.searchArticlesByKeyword.mockRejectedValue(error);

      await expect(searchArticles(mockRequest, mockReply)).rejects.toThrow('Database error');
    });
  });
});
