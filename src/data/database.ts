import { ClickHouseLogLevel, createClient } from '@clickhouse/client';
import { requireClickHouse, type Config } from '../config/index.js';

export type TableName =
  'drii_meetings_v1' | 'drii_decision_events_v1' | 'drii_sources_v1';
export interface Database {
  query(sql: string, parameters?: Record<string, unknown>): Promise<unknown[]>;
  command(sql: string, parameters?: Record<string, unknown>): Promise<void>;
  insert(table: TableName, rows: Record<string, unknown>[]): Promise<void>;
  close(): Promise<void>;
}
export class DatabaseError extends Error {
  constructor() {
    super(
      'ClickHouse request failed. Check endpoint, credentials, database permissions and connectivity.',
    );
    this.name = 'DatabaseError';
  }
}

export function createDatabase(
  config: Config,
  database = config.CLICKHOUSE_DATABASE,
): Database {
  const client = createClient({
    url: requireClickHouse(config),
    username: config.CLICKHOUSE_USER,
    password: config.CLICKHOUSE_PASSWORD,
    database,
    request_timeout: config.CLICKHOUSE_TIMEOUT_MS,
    application: 'drii',
    log: { level: ClickHouseLogLevel.OFF },
    clickhouse_settings: { async_insert: 0, wait_end_of_query: 1 },
  });
  return {
    async query(sql, parameters = {}) {
      try {
        const result = await client.query({
          query: sql,
          query_params: parameters,
          format: 'JSONEachRow',
        });
        return await result.json<unknown>();
      } catch {
        throw new DatabaseError();
      }
    },
    async command(sql, parameters = {}) {
      try {
        await client.command({ query: sql, query_params: parameters });
      } catch {
        throw new DatabaseError();
      }
    },
    async insert(table, rows) {
      if (!rows.length) return;
      try {
        await client.insert({ table, values: rows, format: 'JSONEachRow' });
      } catch {
        throw new DatabaseError();
      }
    },
    async close() {
      await client.close();
    },
  };
}
