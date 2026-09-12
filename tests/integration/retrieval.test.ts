import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import documents from '../../fixtures/demo/sources.json' with { type: 'json' };
import reply from '../../fixtures/demo/follow-up.json' with { type: 'json' };
import { loadConfig } from '../../src/config/index.js';
import {
  EMBEDDING_DIMENSIONS,
  SourceSchema,
} from '../../src/contracts/index.js';
import type { Embedder } from '../../src/data/chunks.js';
import { createDatabase } from '../../src/data/database.js';
import { ClickHouseSourceStore } from '../../src/data/sources.js';
import { ClickHouseEvidenceRetriever } from '../../src/data/retrieval.js';
import { setupSchema } from '../../src/data/schema.js';
import { OpenAIEmbedder } from '../../src/data/embeddings.js';

// These vectors test real SQL deterministically. They are never a demo fallback.
const fixedEmbedder: Embedder = {
  model: 'integration-test-vector',
  embed: async (texts) =>
    texts.map((text) =>
      Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) =>
        i === (text.includes('unrelated') ? 1 : 0) ? 1 : 0,
      ),
    ),
};
describe.skipIf(process.env.DRII_LIVE_TESTS !== '1')(
  'real ClickHouse scoped ranking with synthetic test vectors',
  () => {
    it('handles duplicate seeds, historical revisions, restricted sources, cross-scope and fresh replies', async () => {
      const db = createDatabase(loadConfig());
      const workspaceId = `integration-retrieval-${randomUUID()}`;
      try {
        await setupSchema(db);
        const store = new ClickHouseSourceStore(db, fixedEmbedder);
        const sources = documents.map((d) =>
          SourceSchema.parse({ ...d, workspaceId }),
        );
        for (const source of sources) await store.ingestSource(source);
        for (const source of sources) await store.ingestSource(source);
        const retriever = new ClickHouseEvidenceRetriever(db, fixedEmbedder);
        const scope = {
          workspaceId,
          projectId: 'launch',
          decisionId: 'd',
          revision: 0,
          asOf: '2026-09-12T08:00:00.000Z',
        };
        const latest = await store.getSource(
          workspaceId,
          'launch',
          'support-capacity',
          scope.asOf,
        );
        expect(latest?.revision).toBe(1);
        expect(
          await store.getMetric(
            workspaceId,
            'launch',
            'support-capacity',
            'available_agents',
            scope.asOf,
          ),
        ).toMatchObject({ value: 1, unit: 'people' });
        expect(
          (
            await store.getSource(
              workspaceId,
              'launch',
              'support-capacity',
              '2026-09-11T08:00:00.000Z',
            )
          )?.revision,
        ).toBe(0);
        expect(
          (await retriever.retrieveEvidence('unrelated', scope)).status,
        ).toBe('EMPTY');
        expect(
          (
            await retriever.retrieveEvidence('staffing', {
              ...scope,
              workspaceId: 'other',
            })
          ).status,
        ).toBe('EMPTY');
        expect(
          (
            await retriever.retrieveEvidence('staffing', {
              ...scope,
              projectId: 'other',
            })
          ).status,
        ).toBe('EMPTY');
        expect(
          (
            await retriever.retrieveEvidence('private', {
              ...scope,
              sourceIds: ['restricted-finance'],
            })
          ).status,
        ).toBe('UNAVAILABLE');
        const found = await retriever.retrieveEvidence('staffing', {
          ...scope,
          sourceIds: ['support-capacity'],
        });
        expect(found.status).toBe('FOUND');
        expect(found.evidence).toHaveLength(1);
        expect(found.evidence[0]?.sourceRevision).toBe(1);
        const followScope = {
          ...scope,
          sourceIds: ['support-follow-up'],
          asOf: '2026-09-12T08:11:00.000Z',
        };
        expect(
          (await retriever.retrieveEvidence('staffing', followScope)).status,
        ).toBe('UNAVAILABLE');
        await store.ingestSource(SourceSchema.parse({ ...reply, workspaceId }));
        expect(
          (await retriever.retrieveEvidence('staffing', followScope)).status,
        ).toBe('FOUND');
        expect(
          (
            await retriever.retrieveEvidence('staffing', {
              ...followScope,
              asOf: scope.asOf,
            })
          ).status,
        ).toBe('UNAVAILABLE');
        const revoked = SourceSchema.parse({
          ...sources[0],
          revision: 1,
          visibility: 'RESTRICTED',
        });
        await store.ingestSource(revoked);
        expect(
          await store.getSource(
            workspaceId,
            'launch',
            revoked.sourceId,
            scope.asOf,
          ),
        ).toBeNull();
      } finally {
        await db.close();
      }
    }, 60_000);
  },
);
describe.skipIf(
  process.env.DRII_LIVE_TESTS !== '1' || !process.env.OPENAI_API_KEY,
)('live OpenAI embedding access', () => {
  it('returns one finite 1536-dimensional vector from the configured model', async () => {
    const vectors = await new OpenAIEmbedder(loadConfig()).embed([
      'Synthetic demo: verify support staffing for a limited pilot.',
    ]);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(vectors[0]?.every(Number.isFinite)).toBe(true);
  }, 60_000);
});
