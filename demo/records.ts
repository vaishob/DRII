import type { z } from 'zod';
import type { Records } from '../src/data/records.js';

export const DEMO_STORAGE_PREFIX = 'drii-hosted-demo:v1:';
type DemoStorage = Pick<Storage, 'getItem' | 'setItem'>;

// Only this visitor's browser stores demo transcripts and decision events.
// Reading through the domain schema also rejects stale or corrupted snapshots.
export class BrowserRecords implements Records {
  constructor(private readonly storage: DemoStorage) {}

  private key(workspace: string, namespace: string, key: string): string {
    return DEMO_STORAGE_PREFIX + JSON.stringify([workspace, namespace, key]);
  }

  async get<T>(
    workspace: string,
    namespace: string,
    key: string,
    schema: z.ZodType<T>,
  ): Promise<T | null> {
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.key(workspace, namespace, key));
    } catch {
      throw new Error(
        'Browser storage is unavailable. Allow site storage to use this demo.',
      );
    }
    if (raw === null) return null;
    try {
      return schema.parse(JSON.parse(raw));
    } catch {
      throw new Error(
        'This saved demo record could not be read. Start a new session.',
      );
    }
  }

  async put(
    workspace: string,
    namespace: string,
    key: string,
    value: unknown,
  ): Promise<void> {
    try {
      this.storage.setItem(
        this.key(workspace, namespace, key),
        JSON.stringify(value),
      );
    } catch {
      throw new Error(
        'Browser storage is full or unavailable. Clear this site’s stored data to start again.',
      );
    }
  }
}
