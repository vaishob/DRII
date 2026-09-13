import { createHash as nodeHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { BrowserRecords, DEMO_STORAGE_PREFIX } from '../demo/records.js';
import { createHash } from '../demo/crypto.js';
import { createDemoRuntime, SAMPLE_TRANSCRIPT } from '../demo/runtime.js';
import { RoomSchema } from '../src/room/session.js';
import { DecisionSchema } from '../src/contracts/index.js';

function browserStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
  };
}

it('keeps workflow SHA-256 IDs identical in browser and Node', () => {
  const content = JSON.stringify(['Meeting', 'contradiction ✓', '工程']);
  expect(createHash('sha256').update(content).digest('hex')).toBe(
    nodeHash('sha256').update(content).digest('hex'),
  );
});

it('restores a sourced scripted review across browser runtime instances and isolates visitors', async () => {
  const storage = browserStorage();
  const first = createDemoRuntime(storage);
  const room = RoomSchema.parse(await first('start'));
  await first('segment', {
    id: room.id,
    segment: {
      id: 'sample',
      text: SAMPLE_TRANSCRIPT,
      startMs: 0,
      endMs: 1000,
      finalized: true,
    },
  });
  const reviewed = z
    .object({ decision: DecisionSchema })
    .parse(await first('review', { id: room.id }));
  expect(reviewed.decision.state).toBe('NEEDS_INPUT');
  expect(reviewed.decision.claims[0]?.status).toBe('CONTRADICTED');
  expect(reviewed.decision.evidence.every((e) => e.synthetic)).toBe(true);
  const restored = z
    .object({ decision: DecisionSchema })
    .parse(await createDemoRuntime(storage)('status', { id: room.id }));
  expect(restored.decision).toEqual(reviewed.decision);
  await expect(
    createDemoRuntime(browserStorage())('status', { id: room.id }),
  ).rejects.toThrow('unavailable');
  await expect(first('transcribe')).rejects.toThrow('unavailable');
});

it('rejects corrupt stored records and explains unavailable browser storage', async () => {
  const storage = browserStorage();
  const records = new BrowserRecords(storage);
  storage.setItem(
    DEMO_STORAGE_PREFIX + JSON.stringify(['w', 'n', 'k']),
    '{broken',
  );
  await expect(records.get('w', 'n', 'k', z.string())).rejects.toThrow(
    'could not be read',
  );
  const blocked = new BrowserRecords({
    ...storage,
    setItem: () => {
      throw new Error('quota');
    },
  });
  await expect(blocked.put('w', 'n', 'k', {})).rejects.toThrow(
    'storage is full',
  );
});
