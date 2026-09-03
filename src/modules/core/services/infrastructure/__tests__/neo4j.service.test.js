import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runNeo4jQuery } from '../neo4j.service.js';
import { neo4jDriver } from '../../../../../config/neo4j.js';

vi.mock('../../../../../config/neo4j.js', () => ({
  neo4jDriver: {
    session: vi.fn(),
  },
}));

describe('Neo4j Service', () => {
  let mockSession;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = {
      run: vi.fn(),
      close: vi.fn(),
    };
    neo4jDriver.session.mockReturnValue(mockSession);
  });

  it('should run cypher query and close session successfully', async () => {
    mockSession.run.mockResolvedValue({ records: [] });

    const result = await runNeo4jQuery('MATCH (n) RETURN n', { id: 1 });

    expect(neo4jDriver.session).toHaveBeenCalledWith({ defaultAccessMode: 'WRITE' });
    expect(mockSession.run).toHaveBeenCalledWith('MATCH (n) RETURN n', { id: 1 });
    expect(mockSession.close).toHaveBeenCalled();
    expect(result).toEqual({ records: [] });
  });

  it('should close session even if query fails', async () => {
    const error = new Error('Query failed');
    mockSession.run.mockRejectedValue(error);

    await expect(runNeo4jQuery('INVALID CYPHER')).rejects.toThrow('Query failed');

    expect(mockSession.close).toHaveBeenCalled();
  });
});
