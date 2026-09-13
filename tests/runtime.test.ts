import { describe, expect, it, vi } from 'vitest';
import { RuntimeResources, StartupError } from '../src/runtime.js';

describe('partial startup and shutdown', () => {
  it('bounds a stalled connection attempt and still permits cleanup', async () => {
    vi.useFakeTimers();
    try {
      const runtime = new RuntimeResources();
      const cleanup = vi.fn(async () => undefined);
      runtime.defer(cleanup);
      const result = runtime.stage(
        'Socket Mode',
        () => new Promise<never>(() => undefined),
        30_000,
      );
      const rejected = expect(result).rejects.toEqual(
        new StartupError('Socket Mode'),
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      await runtime.close();
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it('closes earlier resources after connection failure without exposing its payload', async () => {
    const runtime = new RuntimeResources();
    const closed: string[] = [];
    runtime.defer(async () => {
      closed.push('database');
    });
    runtime.defer(async () => {
      closed.push('room');
    });
    await expect(
      runtime.stage('Slack Socket Mode connection', async () => {
        throw new Error('xoxb-secret and raw provider response');
      }),
    ).rejects.toEqual(new StartupError('Slack Socket Mode connection'));
    await runtime.close();
    expect(closed).toEqual(['room', 'database']);
  });

  it('continues cleanup after a failed stop and closes only once on concurrent signals', async () => {
    const runtime = new RuntimeResources();
    const closeDatabase = vi.fn(async () => undefined);
    const stopSlack = vi.fn(async () => {
      throw new Error('stop failed');
    });
    runtime.defer(closeDatabase);
    runtime.defer(stopSlack);
    const results = await Promise.allSettled([
      runtime.close(),
      runtime.close(),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      'rejected',
      'rejected',
    ]);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(stopSlack).toHaveBeenCalledTimes(1);
  });
});
