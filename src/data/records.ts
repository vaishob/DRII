import { z } from 'zod';
import type { Database } from './database.js';
import { DecisionQueue } from './queue.js';

export interface Records {
  get<T>(
    workspace: string,
    namespace: string,
    key: string,
    schema: z.ZodType<T>,
  ): Promise<T | null>;
  put(
    workspace: string,
    namespace: string,
    key: string,
    value: unknown,
  ): Promise<void>;
}
const queue = new DecisionQueue();
const Row = z.object({
  revision: z.coerce.number().int(),
  payload: z.string(),
});
// Shared by Slack receipts and assumption checks. Single application writer.
export class ClickHouseRecords implements Records {
  constructor(private readonly db: Database) {}
  private async row(workspace: string, namespace: string, key: string) {
    const rows = await this.db.query(
      'SELECT revision, payload FROM drii_records_v1 WHERE workspace_id={workspace:String} AND namespace={namespace:String} AND record_key={key:String} ORDER BY revision DESC, payload DESC LIMIT 1',
      { workspace, namespace, key },
    );
    return rows[0] ? Row.parse(rows[0]) : null;
  }
  async get<T>(
    workspace: string,
    namespace: string,
    key: string,
    schema: z.ZodType<T>,
  ): Promise<T | null> {
    const row = await this.row(workspace, namespace, key);
    return row ? schema.parse(JSON.parse(row.payload)) : null;
  }
  async put(
    workspace: string,
    namespace: string,
    key: string,
    value: unknown,
  ): Promise<void> {
    await queue.run(workspace, JSON.stringify([namespace, key]), async () => {
      const previous = await this.row(workspace, namespace, key);
      const payload = JSON.stringify(value);
      if (previous?.payload === payload) return;
      await this.db.insert('drii_records_v1', [
        {
          workspace_id: workspace,
          namespace,
          record_key: key,
          revision: (previous?.revision ?? -1) + 1,
          payload,
        },
      ]);
    });
  }
}
