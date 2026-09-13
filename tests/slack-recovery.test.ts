import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { LiveController } from '../src/slack/live-controller.js';
import {
  detailBatches,
  evidenceDetails,
  liveCard,
  reviewDetails,
} from '../src/slack/live-cards.js';
import type { SlackPort } from '../src/slack/ports.js';
import { DecisionEngine } from '../src/intelligence/engine.js';
import {
  DurableDecisionWorkflow,
  stableId,
} from '../src/intelligence/workflow.js';
import {
  DemoSources,
  MemoryDecisions,
  MemoryRecords,
  ScriptedModel,
} from './simulation.js';

function setup() {
  const records = new MemoryRecords();
  const sources = new DemoSources();
  sources.sources = sources.sources.map((s) => ({
    ...s,
    workspaceId: 'TDEMO',
  }));
  const workflow = new DurableDecisionWorkflow(
    new MemoryDecisions(records),
    sources,
    new DecisionEngine(new ScriptedModel(), sources),
    () => '2026-09-12T09:00:00.000Z',
  );
  let posts = 0;
  const slack: SlackPort = {
    post: vi
      .fn<SlackPort['post']>()
      .mockImplementation(async () => `100.${++posts}`),
    update: vi.fn<SlackPort['update']>().mockResolvedValue(),
    ephemeral: vi.fn<SlackPort['ephemeral']>().mockResolvedValue(),
    getFile: vi.fn(),
    getMessage: vi.fn(),
  };
  const dependencies = {
    workspace: 'TDEMO',
    channel: 'CDEMO',
    project: 'launch',
    owner: { actorId: 'UOWNER', displayName: 'Owner', role: 'Owner' },
    workflow,
    records,
    slack,
    logger: { error: vi.fn(), warn: vi.fn() },
    transcriber: { transcribeMeeting: vi.fn() },
    download: vi.fn(),
  };
  const controller = new LiveController(dependencies);
  const mention = (ts: string) => ({
    workspaceId: 'TDEMO',
    channelId: 'CDEMO',
    userId: 'UOWNER',
    ts,
    threadTs: '100.0',
    text: '<@UBOT> analyze: We must decide about launch; all blocking bugs are fixed.',
  });
  return { records, workflow, slack, controller, dependencies, mention };
}
function action(
  id: string,
  revision: number,
  name = 'request',
  messageTs = '100.1',
) {
  return {
    team: { id: 'TDEMO' },
    channel: { id: 'CDEMO' },
    user: { id: 'UOWNER' },
    message: { ts: messageTs },
    actions: [
      {
        action_id: `drii_live_${name}`,
        action_ts: '200.0',
        value: JSON.stringify({ id, revision }),
      },
    ],
    state: {
      values: {
        [`recipient_${revision}`]: {
          drii_live_recipient: { selected_user: 'USUPPORT' },
        },
      },
    },
  };
}

it('routes a reply to its persisted question even after a second review replaces the latest thread reference', async () => {
  const s = setup();
  await s.controller.handleMention(s.mention('101.0'), 'UBOT');
  const id = stableId('TDEMO', 'CDEMO', '101.0');
  await s.controller.handleAction(
    action(id, (await s.workflow.get('TDEMO', id)).revision),
  );
  const pending = await s.workflow.get('TDEMO', id);
  await s.controller.handleMention(s.mention('102.0'), 'UBOT');
  const otherId = stableId('TDEMO', 'CDEMO', '102.0');
  const other = await s.workflow.get('TDEMO', otherId);
  await new LiveController(s.dependencies).handleReply({
    workspace: 'TDEMO',
    channel: 'CDEMO',
    thread: '100.0',
    user: 'USUPPORT',
    ts: '1789200600.0',
    text: `${pending.followUps[0]!.questionId}: We can cover the pilot.`,
  });
  expect((await s.workflow.get('TDEMO', id)).state).toBe('READY_FOR_REVIEW');
  expect(await s.workflow.get('TDEMO', otherId)).toEqual(other);
});

it('recovers a confirmed follow-up after a failed card update without sending it twice', async () => {
  const s = setup();
  await s.controller.handleMention(s.mention('101.0'), 'UBOT');
  const id = stableId('TDEMO', 'CDEMO', '101.0');
  const request = action(id, (await s.workflow.get('TDEMO', id)).revision);
  vi.mocked(s.slack.update).mockRejectedValueOnce(new Error('Disconnected'));
  await s.controller.handleAction(request);
  expect((await s.workflow.get('TDEMO', id)).followUps[0]!.status).toBe(
    'CONFIRMED',
  );
  await new LiveController(s.dependencies).handleAction(request);
  expect(s.slack.post).toHaveBeenCalledTimes(2);
  expect(vi.mocked(s.slack.update).mock.lastCall?.[2]).toBe(
    'DRII: NEEDS_INPUT',
  );
});

it('never automatically duplicates an uncertain follow-up, and lets the owner explicitly retry it once', async () => {
  const s = setup();
  await s.controller.handleMention(s.mention('101.0'), 'UBOT');
  const id = stableId('TDEMO', 'CDEMO', '101.0');
  const request = action(id, (await s.workflow.get('TDEMO', id)).revision);
  vi.mocked(s.slack.post).mockRejectedValueOnce(
    new Error('Lost acknowledgement'),
  );
  await s.controller.handleAction(request);
  await new LiveController(s.dependencies).handleAction(request);
  expect(s.slack.post).toHaveBeenCalledTimes(2);
  const retry = action(
    id,
    (await s.workflow.get('TDEMO', id)).revision,
    'retry_request',
  );
  retry.actions[0]!.action_ts = '201.0';
  await s.controller.handleAction({ ...retry, user: { id: 'UOTHER' } });
  expect(s.slack.post).toHaveBeenCalledTimes(2);
  await s.controller.handleAction(retry);
  await s.controller.handleAction(retry);
  expect(s.slack.post).toHaveBeenCalledTimes(3);
  expect(vi.mocked(s.slack.post).mock.lastCall?.[2]).not.toContain(
    'Can Support',
  );
  expect(JSON.stringify(vi.mocked(s.slack.post).mock.lastCall?.[3])).toContain(
    'Can Support',
  );
});

it('makes every exact evidence excerpt and metric reachable without exceeding Slack message limits', async () => {
  const s = setup();
  await s.controller.handleMention(s.mention('101.0'), 'UBOT');
  const d = await s.workflow.get('TDEMO', stableId('TDEMO', 'CDEMO', '101.0'));
  const excerpt = '🧪 data '.repeat(1500) + 'LAST EXACT EVIDENCE';
  const evidence = { ...d.evidence[0]!, excerpt };
  const details = evidenceDetails({
    ...d,
    evidence: Array.from({ length: 60 }, (_, i) => ({
      ...evidence,
      evidenceId: `evidence-${i}`,
    })),
  });
  const batches = detailBatches(details);
  const extracted = batches
    .flat()
    .map(
      (b) =>
        z.object({ text: z.object({ text: z.string() }) }).parse(b).text.text,
    );
  expect(extracted.join('')).toBe(details.join(''));
  expect(details[0]).toContain('Evidence ID: evidence-0');
  expect(details[0]).toContain('Metrics:');
  for (const batch of batches) {
    expect(batch.length).toBeLessThanOrEqual(40);
    expect(
      batch.reduce(
        (total, block) =>
          total +
          z.object({ text: z.object({ text: z.string() }) }).parse(block).text
            .text.length,
        0,
      ),
    ).toBeLessThanOrEqual(24_000);
  }
  expect(extracted.every((text) => text.length <= 2800)).toBe(true);
  expect(reviewDetails(d).join('\n')).toContain('Conditional recommendation');
});

it('reports the actionable intake failure instead of hiding it behind a generic retry error', async () => {
  const s = setup();
  vi.mocked(s.slack.getMessage).mockResolvedValue({
    ts: '100.0',
    text: '',
    fileIds: [],
  });
  await s.controller.handleMention(
    { ...s.mention('101.0'), text: '<@UBOT> analyze' },
    'UBOT',
  );
  expect(vi.mocked(s.slack.ephemeral).mock.lastCall?.[3]).toContain(
    'Upload one MP3',
  );
});

it('keeps an approval visibly saved when Slack delivery fails, and exposes only the option whose action plan was reviewed', async () => {
  const s = setup();
  await s.controller.handleMention(s.mention('101.0'), 'UBOT');
  const id = stableId('TDEMO', 'CDEMO', '101.0');
  await s.controller.handleAction(
    action(id, (await s.workflow.get('TDEMO', id)).revision),
  );
  const pending = await s.workflow.get('TDEMO', id);
  await s.controller.handleReply({
    workspace: 'TDEMO',
    channel: 'CDEMO',
    thread: '100.0',
    user: 'USUPPORT',
    ts: '1789200600.0',
    text: `${pending.followUps[0]!.questionId}: We can cover the pilot.`,
  });
  const ready = await s.workflow.get('TDEMO', id);
  const picker = liveCard(ready)
    .filter((b) => b.type === 'actions')
    .flatMap((b) => b.elements)
    .find((e) => 'action_id' in e && e.action_id === 'drii_live_option');
  expect(picker).toMatchObject({
    options: [{ value: 'option:0', text: { text: 'Limited pilot' } }],
  });
  vi.mocked(s.slack.update).mockRejectedValueOnce(
    new Error('Slack unavailable'),
  );
  await s.controller.handleAction({
    ...action(id, ready.revision, 'approve'),
    state: {
      values: {
        [`option_${ready.revision}`]: {
          drii_live_option: { selected_option: { value: 'option:0' } },
        },
      },
    },
  });
  expect((await s.workflow.get('TDEMO', id)).state).toBe('APPROVED');
  expect(
    vi
      .mocked(s.slack.ephemeral)
      .mock.calls.some((call) => call[3].includes('Approval was saved')),
  ).toBe(true);
  const indexing = vi
    .spyOn(s.workflow, 'indexApprovedDecision')
    .mockRejectedValueOnce(new Error('Index unavailable'));
  await new LiveController(s.dependencies).handleMention(
    { ...s.mention('103.0'), text: `<@UBOT> open ${id}` },
    'UBOT',
  );
  expect(vi.mocked(s.slack.update).mock.lastCall?.[2]).toBe('DRII: APPROVED');
  expect(indexing).toHaveBeenCalled();
  expect(vi.mocked(s.slack.ephemeral).mock.lastCall?.[3]).toContain(
    'context indexing is pending',
  );
  expect((await s.workflow.get('TDEMO', id)).state).toBe('APPROVED');
});

it('recovers an imported saved review after its first Slack post fails, without reposting an automatically redelivered open command', async () => {
  const s = setup();
  await s.controller.handleMention(s.mention('101.0'), 'UBOT');
  const id = stableId('TDEMO', 'CDEMO', '101.0');
  const decision = await s.workflow.get('TDEMO', id);
  // Room decisions have durable workflow data before their first Slack run exists.
  s.records.rows.delete(JSON.stringify(['TDEMO', 'slack-run', id]));
  const open = { ...s.mention('103.0'), text: `<@UBOT> open ${id}` };
  vi.mocked(s.slack.post).mockRejectedValueOnce(
    new Error('Connection interrupted'),
  );
  await s.controller.handleMention(open, 'UBOT');
  expect(
    await s.records.get(
      'TDEMO',
      'slack-run',
      id,
      z.object({ messageTs: z.string().nullable() }),
    ),
  ).toEqual({ messageTs: null });
  expect(s.slack.post).toHaveBeenCalledTimes(2);
  const restarted = new LiveController(s.dependencies);
  await restarted.handleMention(open, 'UBOT');
  expect(s.slack.post).toHaveBeenCalledTimes(2);
  expect(vi.mocked(s.slack.ephemeral).mock.lastCall?.[3]).toContain(
    'Saved decision is available',
  );
  await restarted.handleMention({ ...open, ts: '104.0' }, 'UBOT');
  expect(s.slack.post).toHaveBeenCalledTimes(3);
  expect(
    (
      await s.records.get(
        'TDEMO',
        'slack-run',
        id,
        z.object({ messageTs: z.string().nullable() }),
      )
    )?.messageTs,
  ).not.toBeNull();
  expect(await s.workflow.get('TDEMO', id)).toEqual(decision);
  expect(vi.mocked(s.slack.update).mock.lastCall?.[2]).toBe(
    'DRII: NEEDS_INPUT',
  );
});
