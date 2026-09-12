import { expect, it } from 'vitest';
import { RoomSessions } from '../src/room/session.js';
import { createRoomServer } from '../src/room/server.js';
import { DurableDecisionWorkflow } from '../src/intelligence/workflow.js';
import { DecisionEngine } from '../src/intelligence/engine.js';
import {
  DemoSources,
  MemoryRecords,
  MemoryDecisions,
  ScriptedModel,
} from './simulation.js';

function setup() {
  const records = new MemoryRecords();
  const sources = new DemoSources();
  const workflow = new DurableDecisionWorkflow(
    new MemoryDecisions(records),
    sources,
    new DecisionEngine(new ScriptedModel(), sources),
  );
  let time = Date.parse('2026-09-12T09:00:00Z');
  const sessions = new RoomSessions(
    records,
    workflow,
    'demo-workspace',
    'launch',
    { actorId: 'owner', displayName: 'Owner', role: 'Owner' },
    () => time,
  );
  return {
    sessions,
    advance: () => {
      time += 60_000;
    },
  };
}
it('deduplicates finalized segments, respects stop/mute, and limits repeated objections', async () => {
  const h = setup();
  const room = await h.sessions.create();
  const segment = {
    id: 's1',
    text: 'We must decide whether to launch. All blocking bugs are fixed.',
    startMs: 0,
    endMs: 1000,
    finalized: true,
  };
  await expect(
    h.sessions.append(room.id, { ...segment, finalized: false }),
  ).rejects.toThrow();
  await h.sessions.append(room.id, segment);
  await h.sessions.append(room.id, segment);
  expect((await h.sessions.get(room.id)).segments).toHaveLength(1);
  await expect(
    h.sessions.append(room.id, { ...segment, text: 'different' }),
  ).rejects.toThrow('different');
  const review = await h.sessions.review(room.id);
  expect(review.decision?.claims[0]?.status).toBe('CONTRADICTED');
  expect((await h.sessions.review(room.id)).suppressed).toBe(true);
  await h.sessions.control(room.id, 'mute');
  await h.sessions.append(room.id, {
    ...segment,
    id: 's2',
    startMs: 1001,
    endMs: 2000,
  });
  expect((await h.sessions.review(room.id)).retryAfterMs).toBeGreaterThan(0);
  h.advance();
  expect((await h.sessions.review(room.id)).suppressed).toBe(true);
  await h.sessions.control(room.id, 'stop');
  await expect(
    h.sessions.append(room.id, { ...segment, id: 's3' }),
  ).rejects.toThrow('stopped');
});
it('requires loopback origin and a page token before accepting capture or transcription', async () => {
  const h = setup();
  const port = 3182;
  const server = createRoomServer(
    h.sessions,
    async () => 'text',
    '<script>const token="__ROOM_TOKEN__";</script>',
    port,
  );
  await new Promise<void>((resolve) =>
    server.listen(port, '127.0.0.1', resolve),
  );
  try {
    const origin = `http://127.0.0.1:${port}`;
    const page = await (await fetch(origin)).text();
    const token = /token="([a-f0-9]+)"/.exec(page)![1]!;
    expect(
      (await fetch(origin + '/api/start', { method: 'POST', body: '{}' }))
        .status,
    ).toBe(403);
    expect(
      (
        await fetch(origin + '/api/start', {
          method: 'POST',
          headers: {
            Origin: 'https://attacker.example',
            'X-Room-Token': token,
          },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    const response = await fetch(origin + '/api/start', {
      method: 'POST',
      headers: { Origin: origin, 'X-Room-Token': token },
      body: '{}',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ active: true });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});
