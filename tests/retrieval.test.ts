import { describe, expect, it, vi } from 'vitest';
import documents from '../fixtures/demo/sources.json' with { type: 'json' };
import { EMBEDDING_DIMENSIONS, SourceSchema } from '../src/contracts/index.js';
import type { Embedder } from '../src/data/chunks.js';
import type { Database } from '../src/data/database.js';
import { ClickHouseEvidenceRetriever } from '../src/data/retrieval.js';

const scope = {
  workspaceId: 'demo-workspace',
  projectId: 'launch',
  decisionId: 'd',
  revision: 1,
  asOf: '2026-09-12T08:00:00.000Z',
};
const source = SourceSchema.parse(documents[0]);
const row = {
  payload: JSON.stringify(source),
  chunk_id: 'chunk',
  excerpt: source.content,
  distance: 0.2,
};
function adapters() {
  const db: Database = {
    query: vi.fn<Database['query']>().mockResolvedValue([row]),
    insert: vi.fn<Database['insert']>().mockResolvedValue(),
    command: vi.fn<Database['command']>().mockResolvedValue(),
    close: vi.fn<Database['close']>().mockResolvedValue(),
  };
  const embedder: Embedder = {
    model: 'test-vector',
    embed: vi
      .fn<Embedder['embed']>()
      .mockResolvedValue([
        Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) =>
          i === 0 ? 1 : 0,
        ),
      ]),
  };
  return {
    db,
    embedder,
    retriever: new ClickHouseEvidenceRetriever(db, embedder),
  };
}
describe('scoped evidence retrieval', () => {
  it('returns exact excerpts and provenance with relevance explicitly labeled', async () => {
    const { db, retriever } = adapters();
    const result = await retriever.retrieveEvidence('billing blockers', scope);
    expect(result.status).toBe('FOUND');
    expect(result.evidence[0]?.excerpt).toBe(source.content);
    expect(result.evidence[0]?.sourceRevision).toBe(source.revision);
    expect(result.evidence[0]?.relevance).toEqual({
      method: 'COSINE',
      score: 0.8,
      model: 'test-vector',
    });
    expect(vi.mocked(db.query).mock.calls[0]?.[1]).toMatchObject({
      workspace: scope.workspaceId,
      project: scope.projectId,
      asOf: Date.parse(scope.asOf),
      limit: 5,
      dimensions: 1536,
    });
  });
  it('distinguishes empty results, inaccessible explicit sources and provider failures', async () => {
    const { db, embedder, retriever } = adapters();
    vi.mocked(db.query).mockResolvedValue([]);
    expect(
      (await retriever.retrieveEvidence('unrelated query', scope)).status,
    ).toBe('EMPTY');
    vi.mocked(embedder.embed).mockClear();
    expect(
      (
        await retriever.retrieveEvidence('private record', {
          ...scope,
          sourceIds: ['restricted-finance'],
        })
      ).status,
    ).toBe('UNAVAILABLE');
    expect(embedder.embed).not.toHaveBeenCalled();
    vi.mocked(db.query).mockRejectedValue(new Error('database timeout'));
    expect(await retriever.retrieveEvidence('billing', scope)).toMatchObject({
      status: 'FAILED',
      code: 'DATABASE_ERROR',
    });
    vi.mocked(embedder.embed).mockRejectedValue(new Error('provider timeout'));
    expect(await retriever.retrieveEvidence('billing', scope)).toMatchObject({
      status: 'FAILED',
      code: 'EMBEDDING_ERROR',
    });
  });
  it('rejects invalid limits before sending requests and makes blank search a no-op', async () => {
    const { db, embedder, retriever } = adapters();
    await expect(
      retriever.retrieveEvidence('billing', { ...scope, limit: 99 }),
    ).rejects.toThrow();
    expect(await retriever.retrieveEvidence('  ', scope)).toEqual({
      status: 'EMPTY',
      evidence: [],
    });
    expect(embedder.embed).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });
  it('fails closed on cross-scope, future, restricted or fabricated source excerpts', async () => {
    const { db, retriever } = adapters();
    for (const bad of [
      { ...source, workspaceId: 'private' },
      { ...source, projectId: 'private' },
      { ...source, visibility: 'RESTRICTED' },
      { ...source, availableAt: '2027-01-01T00:00:00.000Z' },
      {
        ...source,
        metrics: [{ ...source.metrics[0], measuredAt: '2027-01-01T00:00:00Z' }],
      },
    ]) {
      vi.mocked(db.query).mockResolvedValue([
        { ...row, payload: JSON.stringify(bad) },
      ]);
      expect((await retriever.retrieveEvidence('billing', scope)).status).toBe(
        'FAILED',
      );
    }
    vi.mocked(db.query).mockResolvedValue([
      { ...row, excerpt: 'This excerpt was invented.' },
    ]);
    expect((await retriever.retrieveEvidence('billing', scope)).status).toBe(
      'FAILED',
    );
  });
  it('queries again when new evidence arrives instead of caching stale results', async () => {
    const { db, retriever } = adapters();
    vi.mocked(db.query).mockResolvedValueOnce([]).mockResolvedValueOnce([row]);
    expect((await retriever.retrieveEvidence('billing', scope)).status).toBe(
      'EMPTY',
    );
    expect((await retriever.retrieveEvidence('billing', scope)).status).toBe(
      'FOUND',
    );
  });
});
