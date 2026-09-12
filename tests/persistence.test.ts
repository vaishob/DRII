import { describe, expect, it, vi } from 'vitest';
import examples from '../fixtures/contracts/v1/examples.json' with { type: 'json' };
import { DecisionEventSchema } from '../src/contracts/index.js';
import {
  ClickHouseDecisionStore,
  PersistenceConflictError,
} from '../src/data/decisions.js';
import { DecisionQueue } from '../src/data/queue.js';
import type { Database } from '../src/data/database.js';

function fakeDatabase(): Database & {
  query: ReturnType<typeof vi.fn<Database['query']>>;
  insert: ReturnType<typeof vi.fn<Database['insert']>>;
} {
  return {
    query: vi.fn<Database['query']>().mockResolvedValue([]),
    insert: vi.fn<Database['insert']>().mockResolvedValue(),
    command: vi.fn<Database['command']>().mockResolvedValue(),
    close: vi.fn<Database['close']>().mockResolvedValue(),
  };
}
describe('append-only decision storage', () => {
  it('does not duplicate identical events, but rejects reused IDs with changed content', async () => {
    const db = fakeDatabase();
    const store = new ClickHouseDecisionStore(db);
    const event = DecisionEventSchema.parse(examples.DecisionEvent);
    db.query.mockResolvedValue([{ payload: JSON.stringify(event) }]);
    await store.appendDecisionEvent(event);
    expect(db.insert).not.toHaveBeenCalled();
    await expect(
      store.appendDecisionEvent({
        ...event,
        decision: { ...event.decision, summary: 'changed' },
      }),
    ).rejects.toBeInstanceOf(PersistenceConflictError);
  });
  it('binds untrusted identifiers and orders by revision before arrival time', async () => {
    const db = fakeDatabase();
    const store = new ClickHouseDecisionStore(db);
    const hostile = "x' OR 1=1 --";
    await store.getDecision(hostile, 'decision');
    expect(db.query.mock.calls[0]?.[0]).not.toContain(hostile);
    expect(db.query.mock.calls[0]?.[0]).toContain('ORDER BY revision DESC');
    expect(db.query.mock.calls[0]?.[1]).toEqual({
      workspace: hostile,
      decision: 'decision',
    });
  });
  it('validates database payloads instead of trusting stored JSON', async () => {
    const db = fakeDatabase();
    db.query.mockResolvedValue([{ payload: '{"decision":{}}' }]);
    await expect(
      new ClickHouseDecisionStore(db).getDecision('workspace', 'decision'),
    ).rejects.toThrow();
  });
  it('waits for persistence and propagates a write failure', async () => {
    const db = fakeDatabase();
    db.insert.mockRejectedValue(new Error('database unavailable'));
    await expect(
      new ClickHouseDecisionStore(db).appendDecisionEvent(
        DecisionEventSchema.parse(examples.DecisionEvent),
      ),
    ).rejects.toThrow('database unavailable');
  });
});
describe('single-process decision queue', () => {
  it('serializes one decision while allowing another workspace to advance', async () => {
    const queue = new DecisionQueue();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const first = queue.run('a', 'd', async () => {
      order.push('first');
      await gate;
      order.push('finished');
    });
    const second = queue.run('a', 'd', async () => {
      order.push('second');
    });
    await queue.run('b', 'd', async () => {
      order.push('independent');
    });
    expect(order).toEqual(['first', 'independent']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'independent', 'finished', 'second']);
  });
  it('continues after a failed operation and avoids composite-key collisions', async () => {
    const queue = new DecisionQueue();
    await expect(
      queue.run('a:b', 'c', async () => {
        throw new Error('retry me');
      }),
    ).rejects.toThrow('retry me');
    await expect(queue.run('a:b', 'c', async () => 42)).resolves.toBe(42);
    await expect(queue.run('a', 'b:c', async () => 43)).resolves.toBe(43);
  });
});
