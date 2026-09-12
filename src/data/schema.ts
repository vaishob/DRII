import type { Database } from './database.js';

// Append-only MergeTree tables. Logical uniqueness comes from reads and stable
// event/revision IDs, never from background merges or insert deduplication.
export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS drii_records_v1 (
    workspace_id String, namespace String, record_key String,
    revision UInt64, payload String
  ) ENGINE = MergeTree ORDER BY (workspace_id, namespace, record_key, revision)`,
  `CREATE TABLE IF NOT EXISTS drii_meetings_v1 (
    workspace_id String, meeting_id String, revision UInt32,
    created_at_ms UInt64, payload String
  ) ENGINE = MergeTree ORDER BY (workspace_id, meeting_id, revision)`,
  `CREATE TABLE IF NOT EXISTS drii_decision_events_v1 (
    workspace_id String, decision_id String, meeting_id String,
    revision UInt32, event_id String, deduplication_id String,
    created_at_ms UInt64, payload String
  ) ENGINE = MergeTree ORDER BY (workspace_id, decision_id, revision, event_id)`,
  `CREATE TABLE IF NOT EXISTS drii_sources_v1 (
    workspace_id String, project_id String, source_id String, revision UInt32,
    updated_at_ms UInt64, available_at_ms UInt64,
    visibility LowCardinality(String), payload String,
    embedding_model String,
    metrics Array(Tuple(name String, value Float64, unit String, measured_at_ms UInt64)),
    chunks Array(Tuple(chunk_id String, excerpt String, embedding Array(Float32)))
  ) ENGINE = MergeTree ORDER BY (workspace_id, project_id, source_id, revision)`,
] as const;

export async function setupSchema(db: Database): Promise<void> {
  for (const sql of SCHEMA_STATEMENTS) await db.command(sql);
}
