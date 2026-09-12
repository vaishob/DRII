import { describe, expect, it, vi } from 'vitest';
import documents from '../fixtures/demo/sources.json' with { type: 'json' };
import meeting from '../fixtures/demo/meeting.json' with { type: 'json' };
import reply from '../fixtures/demo/follow-up.json' with { type: 'json' };
import expected from '../fixtures/evaluation/retrieval.json' with { type: 'json' };
import {
  EMBEDDING_DIMENSIONS,
  MeetingSchema,
  SourceSchema,
} from '../src/contracts/index.js';
import {
  chunkSource,
  VectorSchema,
  type Embedder,
} from '../src/data/chunks.js';
import { ClickHouseSourceStore } from '../src/data/sources.js';
import type { Database } from '../src/data/database.js';

const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) =>
  i === 0 ? 1 : 0,
);
function adapters() {
  const db: Database = {
    query: vi.fn<Database['query']>().mockResolvedValue([]),
    insert: vi.fn<Database['insert']>().mockResolvedValue(),
    command: vi.fn<Database['command']>().mockResolvedValue(),
    close: vi.fn<Database['close']>().mockResolvedValue(),
  };
  const embedder: Embedder = {
    model: 'test-vector',
    embed: vi
      .fn<Embedder['embed']>()
      .mockImplementation(async (texts) => texts.map(() => vector)),
  };
  return { db, embedder, store: new ClickHouseSourceStore(db, embedder) };
}
describe('synthetic company inputs', () => {
  it('contains three speakers and all expected source references, with the reply withheld', () => {
    const parsed = MeetingSchema.parse(meeting);
    expect(new Set(parsed.segments.map((s) => s.speaker?.actorId)).size).toBe(
      3,
    );
    const sources = documents.map((d) => SourceSchema.parse(d));
    for (const entry of expected.cases)
      for (const id of entry.expectedSourceIds)
        expect(sources.some((s) => s.sourceId === id)).toBe(true);
    expect(sources.some((s) => s.sourceId === expected.laterSourceId)).toBe(
      false,
    );
    expect(SourceSchema.parse(reply).sourceId).toBe(expected.laterSourceId);
    expect(
      sources.every(
        (s) => s.synthetic && s.title.startsWith('SYNTHETIC DEMO:'),
      ),
    ).toBe(true);
  });
  it('preserves exact source content and stable chunk IDs', () => {
    const source = SourceSchema.parse(documents[0]);
    const longer = { ...source, content: source.content.repeat(10) };
    expect(
      chunkSource(longer)
        .map((c) => c.excerpt)
        .join(''),
    ).toBe(longer.content);
    expect(chunkSource(longer)).toEqual(chunkSource(longer));
    expect(chunkSource({ ...longer, revision: 1 })[0]?.chunkId).not.toBe(
      chunkSource(longer)[0]?.chunkId,
    );
  });
  it('rejects zero, nonfinite and dimension-mismatched vectors', () => {
    expect(VectorSchema.safeParse(vector).success).toBe(true);
    expect(VectorSchema.safeParse([1, 2]).success).toBe(false);
    expect(VectorSchema.safeParse(vector.map(() => 0)).success).toBe(false);
    expect(VectorSchema.safeParse([NaN, ...vector.slice(1)]).success).toBe(
      false,
    );
  });
});
describe('source ingestion', () => {
  it('skips exact retries before requesting embeddings', async () => {
    const { db, embedder, store } = adapters();
    const source = SourceSchema.parse(documents[0]);
    vi.mocked(db.query).mockResolvedValue([
      { payload: JSON.stringify(source), embedding_model: embedder.model },
    ]);
    await store.ingestSource(source);
    expect(embedder.embed).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });
  it('does not write partial documents when the embedding provider fails', async () => {
    const { db, embedder, store } = adapters();
    vi.mocked(embedder.embed).mockRejectedValue(new Error('provider failed'));
    await expect(
      store.ingestSource(SourceSchema.parse(documents[0])),
    ).rejects.toThrow('provider failed');
    expect(db.insert).not.toHaveBeenCalled();
  });
  it('stores restricted fixtures without sending their text to the embedding provider', async () => {
    const { db, embedder, store } = adapters();
    await store.ingestSource(
      SourceSchema.parse(documents.find((d) => d.visibility === 'RESTRICTED')),
    );
    expect(embedder.embed).not.toHaveBeenCalled();
    expect(db.insert).toHaveBeenCalledOnce();
  });
});
