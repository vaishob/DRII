import type { ClickHouseClient } from "@clickhouse/client";

export async function createDecisionEventsTable(client: ClickHouseClient, database: string): Promise<void> {
  await client.command({
    query: `CREATE TABLE IF NOT EXISTS ${database}.decision_events (
  event_id String,
  workspace_id String,
  meeting_id String,
  decision_id String,
  revision UInt32,
  occurred_at DateTime64(3, 'UTC'),
  type LowCardinality(String),
  state LowCardinality(String),
  actor_id Nullable(String),
  payload String
) ENGINE = MergeTree
ORDER BY (decision_id, revision, occurred_at, event_id)`,
  });
}
