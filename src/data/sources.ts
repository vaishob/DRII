import { z } from 'zod';
import {
  IdSchema,
  SourceSchema,
  TimestampSchema,
  type Source,
} from '../contracts/index.js';
import type { SourceStore } from '../contracts/services.js';
import { chunkSource, VectorSchema, type Embedder } from './chunks.js';
import type { Database } from './database.js';
import { PersistenceConflictError } from './decisions.js';
import { DecisionQueue } from './queue.js';

const writeQueue = new DecisionQueue();
const RowSchema = z.object({
  payload: z.string(),
  embedding_model: z.string().optional(),
});
// Select the logical current version BEFORE visibility or vector ranking.
// A newer restricted revision must hide an older workspace-visible revision.
export const CURRENT_SOURCES_SQL = `
  SELECT source_id, tupleElement(latest, 1) AS payload,
    tupleElement(latest, 3) AS chunks, tupleElement(latest, 4) AS embedding_model,
    tupleElement(latest, 5) AS metrics
  FROM (
    SELECT source_id, argMax(tuple(payload, visibility, chunks, embedding_model, metrics),
      tuple(revision, updated_at_ms, payload)) AS latest
    FROM drii_sources_v1
    WHERE workspace_id = {workspace:String} AND project_id = {project:String}
      AND available_at_ms <= {asOf:UInt64} AND updated_at_ms <= {asOf:UInt64}
    GROUP BY source_id
  ) WHERE tupleElement(latest, 2) = 'WORKSPACE'`;

export class ClickHouseSourceStore implements SourceStore {
  constructor(
    private readonly db: Database,
    private readonly embedder: Embedder,
  ) {}
  async ingestSource(input: Source): Promise<void> {
    const source = SourceSchema.parse(input);
    if (
      Date.parse(source.updatedAt) > Date.parse(source.availableAt) ||
      source.metrics.some(
        (m) => Date.parse(m.measuredAt) > Date.parse(source.availableAt),
      )
    )
      throw new Error(
        'Source and metric dates cannot be after source availability',
      );
    await writeQueue.run(
      source.workspaceId,
      JSON.stringify([source.projectId, source.sourceId]),
      async () => {
        const existing = await this.db.query(
          `SELECT payload, embedding_model FROM drii_sources_v1
        WHERE workspace_id = {workspace:String} AND project_id = {project:String}
        AND source_id = {source:String} AND revision = {revision:UInt32}`,
          {
            workspace: source.workspaceId,
            project: source.projectId,
            source: source.sourceId,
            revision: source.revision,
          },
        );
        for (const row of existing) {
          const value = RowSchema.parse(row);
          if (
            JSON.stringify(SourceSchema.parse(JSON.parse(value.payload))) !==
              JSON.stringify(source) ||
            value.embedding_model !== this.embedder.model
          )
            throw new PersistenceConflictError();
        }
        if (existing.length) return;
        const chunks = chunkSource(source);
        // Restricted demo documents are stored but never sent to the embedding API.
        const vectors =
          source.visibility === 'WORKSPACE'
            ? await this.embedder.embed(chunks.map((c) => c.excerpt))
            : [];
        if (
          source.visibility === 'WORKSPACE' &&
          vectors.length !== chunks.length
        )
          throw new Error(
            'Embedding provider returned the wrong number of vectors',
          );
        await this.db.insert('drii_sources_v1', [
          {
            workspace_id: source.workspaceId,
            project_id: source.projectId,
            source_id: source.sourceId,
            revision: source.revision,
            updated_at_ms: Date.parse(source.updatedAt),
            available_at_ms: Date.parse(source.availableAt),
            visibility: source.visibility,
            payload: JSON.stringify(source),
            embedding_model: this.embedder.model,
            metrics: source.metrics.map((metric) => ({
              name: metric.name,
              value: metric.value,
              unit: metric.unit,
              measured_at_ms: Date.parse(metric.measuredAt),
            })),
            chunks: chunks.map((c, i) => ({
              chunk_id: c.chunkId,
              excerpt: c.excerpt,
              embedding:
                source.visibility === 'WORKSPACE'
                  ? VectorSchema.parse(vectors[i])
                  : [],
            })),
          },
        ]);
      },
    );
  }
  async getSource(
    workspaceId: string,
    projectId: string,
    sourceId: string,
    asOf: string,
  ): Promise<Source | null> {
    const rows = await this.db.query(
      `SELECT payload FROM (${CURRENT_SOURCES_SQL}) WHERE source_id = {source:String} LIMIT 1`,
      {
        workspace: IdSchema.parse(workspaceId),
        project: IdSchema.parse(projectId),
        source: IdSchema.parse(sourceId),
        asOf: Date.parse(TimestampSchema.parse(asOf)),
      },
    );
    return rows[0]
      ? SourceSchema.parse(JSON.parse(RowSchema.parse(rows[0]).payload))
      : null;
  }

  async getMetric(
    workspaceId: string,
    projectId: string,
    sourceId: string,
    metricName: string,
    asOf: string,
  ) {
    const rows = await this.db.query(
      `SELECT tupleElement(metric, 1) AS name,
      tupleElement(metric, 2) AS value, tupleElement(metric, 3) AS unit,
      toString(tupleElement(metric, 4)) AS measured_at_ms
      FROM (${CURRENT_SOURCES_SQL}) ARRAY JOIN metrics AS metric
      WHERE source_id = {source:String} AND tupleElement(metric, 1) = {metric:String}
      AND tupleElement(metric, 4) <= {asOf:UInt64}
      ORDER BY tupleElement(metric, 4) DESC LIMIT 1`,
      {
        workspace: IdSchema.parse(workspaceId),
        project: IdSchema.parse(projectId),
        source: IdSchema.parse(sourceId),
        metric: IdSchema.parse(metricName),
        asOf: Date.parse(TimestampSchema.parse(asOf)),
      },
    );
    if (!rows[0]) return null;
    const row = z
      .object({
        name: z.string(),
        value: z.number().finite(),
        unit: z.string(),
        measured_at_ms: z.string().regex(/^\d+$/),
      })
      .parse(rows[0]);
    return {
      name: row.name,
      value: row.value,
      unit: row.unit,
      measuredAt: new Date(Number(row.measured_at_ms)).toISOString(),
    };
  }
}
