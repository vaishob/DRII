import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  EvidenceSchema,
  EvidenceScopeSchema,
  SCHEMA_VERSION,
  SourceSchema,
  type EvidenceScope,
  type RetrievalResult,
} from '../contracts/index.js';
import type { EvidenceRetriever } from '../contracts/services.js';
import { VectorSchema, type Embedder } from './chunks.js';
import type { Database } from './database.js';
import { CURRENT_SOURCES_SQL, sourceMatchesScope } from './sources.js';

export const DEFAULT_MIN_RELEVANCE = 0.3;
export const MAX_QUERY_CHARACTERS = 2_000;
const RowSchema = z.object({
  payload: z.string(),
  chunk_id: z.string(),
  excerpt: z.string(),
  distance: z.number().finite(),
});
export const RETRIEVAL_SQL = `
  SELECT payload, tupleElement(chunk, 1) AS chunk_id,
    tupleElement(chunk, 2) AS excerpt,
    cosineDistance(tupleElement(chunk, 3), {vector:Array(Float32)}) AS distance
  FROM (${CURRENT_SOURCES_SQL})
  ARRAY JOIN chunks AS chunk
  WHERE embedding_model = {model:String}
    AND (empty({sourceIds:Array(String)}) OR source_id IN {sourceIds:Array(String)})
    AND length(tupleElement(chunk, 3)) = {dimensions:UInt32}
    AND distance <= {maxDistance:Float64}
  ORDER BY distance ASC, source_id ASC, chunk_id ASC
  LIMIT 1 BY source_id
  LIMIT {limit:UInt32}`;

export class ClickHouseEvidenceRetriever implements EvidenceRetriever {
  constructor(
    private readonly db: Database,
    private readonly embedder: Embedder,
    private readonly minRelevance = DEFAULT_MIN_RELEVANCE,
  ) {
    z.number().min(-1).max(1).parse(minRelevance);
  }
  async retrieveEvidence(
    input: string,
    inputScope: EvidenceScope,
  ): Promise<RetrievalResult> {
    const query = z.string().trim().max(MAX_QUERY_CHARACTERS).parse(input);
    const scope = EvidenceScopeSchema.parse(inputScope);
    if (!query) return { status: 'EMPTY', evidence: [] };
    const parameters = {
      workspace: scope.workspaceId,
      project: scope.projectId,
      asOf: Date.parse(scope.asOf),
      sourceIds: scope.sourceIds ?? [],
    };
    if (parameters.sourceIds.length) {
      try {
        const visible = await this.db.query(
          `SELECT source_id FROM (${CURRENT_SOURCES_SQL}) WHERE source_id IN {sourceIds:Array(String)}`,
          parameters,
        );
        const ids = new Set(
          visible.map(
            (row) => z.object({ source_id: z.string() }).parse(row).source_id,
          ),
        );
        if (parameters.sourceIds.some((id) => !ids.has(id)))
          return {
            status: 'UNAVAILABLE',
            evidence: [],
            reason: 'SOURCE_NOT_ACCESSIBLE',
          };
      } catch {
        return {
          status: 'FAILED',
          evidence: [],
          code: 'DATABASE_ERROR',
          retryable: true,
        };
      }
    }
    let vector: number[];
    try {
      vector = VectorSchema.parse((await this.embedder.embed([query]))[0]);
    } catch {
      return {
        status: 'FAILED',
        evidence: [],
        code: 'EMBEDDING_ERROR',
        retryable: true,
      };
    }
    try {
      const rows = await this.db.query(RETRIEVAL_SQL, {
        ...parameters,
        vector,
        dimensions: vector.length,
        model: this.embedder.model,
        maxDistance: 1 - this.minRelevance,
        limit: scope.limit,
      });
      const evidence = rows.map((value) => {
        const row = RowSchema.parse(value);
        const source = SourceSchema.parse(JSON.parse(row.payload));
        if (
          !sourceMatchesScope(
            source,
            scope.workspaceId,
            scope.projectId,
            scope.asOf,
          ) ||
          (parameters.sourceIds.length > 0 &&
            !parameters.sourceIds.includes(source.sourceId)) ||
          !source.content.includes(row.excerpt)
        )
          throw new Error('Out-of-scope or invalid stored source');
        const id = createHash('sha256')
          .update(
            JSON.stringify([
              scope.workspaceId,
              scope.decisionId,
              source.sourceId,
              source.revision,
              row.chunk_id,
            ]),
          )
          .digest('hex')
          .slice(0, 24);
        return EvidenceSchema.parse({
          schemaVersion: SCHEMA_VERSION,
          workspaceId: scope.workspaceId,
          decisionId: scope.decisionId,
          revision: scope.revision,
          createdAt: scope.asOf,
          sourceIds: [source.sourceId],
          evidenceId: id,
          sourceId: source.sourceId,
          sourceRevision: source.revision,
          chunkId: row.chunk_id,
          excerpt: row.excerpt,
          sourceTitle: source.title,
          sourceType: source.sourceType,
          sourceDate: source.updatedAt,
          sourceUrl: source.url,
          owner: source.owner,
          synthetic: source.synthetic,
          metrics: source.metrics,
          relevance: {
            method: 'COSINE',
            score: Math.max(-1, Math.min(1, 1 - row.distance)),
            model: this.embedder.model,
          },
        });
      });
      return evidence.length
        ? { status: 'FOUND', evidence }
        : { status: 'EMPTY', evidence: [] };
    } catch {
      return {
        status: 'FAILED',
        evidence: [],
        code: 'DATABASE_ERROR',
        retryable: true,
      };
    }
  }
}
