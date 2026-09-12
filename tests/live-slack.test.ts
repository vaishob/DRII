import { expect, it, vi } from 'vitest';
import type { SlackPort, SafeLogger } from '../src/slack/ports.js';
import { LiveController } from '../src/slack/live-controller.js';
import {
  DurableDecisionWorkflow,
  stableId,
} from '../src/intelligence/workflow.js';
import { DecisionEngine } from '../src/intelligence/engine.js';
import {
  DemoSources,
  MemoryDecisions,
  MemoryRecords,
  ScriptedModel,
} from './simulation.js';
import { AssumptionMonitor } from '../src/intelligence/monitor.js';

it('runs real Slack controllers through restart, recipient confirmation, scoped reply and owner approval', async () => {
  const records = new MemoryRecords();
  const sources = new DemoSources();
  sources.sources = sources.sources.map((s) => ({
    ...s,
    workspaceId: 'TDEMO',
  }));
  const store = new MemoryDecisions(records);
  const workflow = new DurableDecisionWorkflow(
    store,
    sources,
    new DecisionEngine(new ScriptedModel(), sources),
    () => '2026-09-12T09:00:00.000Z',
  );
  const slack: SlackPort = {
    post: vi.fn<SlackPort['post']>().mockResolvedValue('100.1'),
    update: vi.fn<SlackPort['update']>().mockResolvedValue(),
    ephemeral: vi.fn<SlackPort['ephemeral']>().mockResolvedValue(),
    getFile: vi.fn<SlackPort['getFile']>(),
    getMessage: vi.fn<SlackPort['getMessage']>(),
  };
  const logger: SafeLogger = { error: vi.fn(), warn: vi.fn() };
  const dependencies = {
    workspace: 'TDEMO',
    channel: 'CDEMO',
    project: 'launch',
    owner: { actorId: 'UOWNER', displayName: 'Owner', role: 'Owner' },
    workflow,
    records,
    slack,
    logger,
    transcriber: { transcribeMeeting: vi.fn() },
    download: vi.fn(),
  };
  const mention = {
    workspaceId: 'TDEMO',
    channelId: 'CDEMO',
    userId: 'UOWNER',
    ts: '100.0',
    text: '<@UBOT> analyze: We must decide about launch; all blocking bugs are fixed.',
  };
  await new LiveController(dependencies).handleMention(mention, 'UBOT');
  const restart = new LiveController({
    ...dependencies,
    workflow: new DurableDecisionWorkflow(
      new MemoryDecisions(records),
      sources,
      new DecisionEngine(new ScriptedModel(), sources),
    ),
  });
  await restart.handleMention(mention, 'UBOT');
  expect(slack.post).toHaveBeenCalledTimes(1);
  const id = stableId('TDEMO', 'CDEMO', '100.0');
  const first = await workflow.get('TDEMO', id);
  expect(first.state).toBe('NEEDS_INPUT');
  const action = (name: string, revision: number, user = 'UOWNER') => ({
    team: { id: 'TDEMO' },
    channel: { id: 'CDEMO' },
    user: { id: user },
    message: { ts: '100.1' },
    actions: [
      {
        action_id: `drii_live_${name}`,
        value: JSON.stringify({ id, revision }),
      },
    ],
  });
  await restart.handleAction(action('request', first.revision));
  expect(slack.post).toHaveBeenCalledTimes(1);
  const request = {
    ...action('request', first.revision),
    state: {
      values: {
        [`recipient_${first.revision}`]: {
          drii_live_recipient: { selected_user: 'USUPPORT' },
        },
      },
    },
  };
  await restart.handleAction(request);
  await restart.handleAction(request);
  expect(slack.post).toHaveBeenCalledTimes(2);
  const pending = await workflow.get('TDEMO', id);
  const question = pending.followUps[0]!;
  const reply = {
    workspace: 'TDEMO',
    channel: 'CDEMO',
    thread: '100.0',
    user: 'USUPPORT',
    ts: '1789200600.0',
    text: question.questionId + ': We can cover the pilot.',
  };
  await restart.handleReply({ ...reply, user: 'UOTHER' });
  expect((await workflow.get('TDEMO', id)).revision).toBe(pending.revision);
  await restart.handleReply(reply);
  const ready = await workflow.get('TDEMO', id);
  expect(ready.state).toBe('READY_FOR_REVIEW');
  const approve = {
    ...action('approve', ready.revision),
    state: {
      values: {
        [`option_${ready.revision}`]: {
          drii_live_option: { selected_option: { value: 'pilot' } },
        },
      },
    },
  };
  await restart.handleAction({ ...approve, user: { id: 'UOTHER' } });
  expect((await workflow.get('TDEMO', id)).state).toBe('READY_FOR_REVIEW');
  await restart.handleAction(approve);
  const approved = await workflow.get('TDEMO', id);
  expect(approved.state).toBe('APPROVED');
  await restart.handleAction(approve);
  await restart.handleReply({ ...reply, ts: '1789200700.0' });
  expect(await workflow.get('TDEMO', id)).toEqual(approved);
  const snapshots = new AssumptionMonitor(sources, records, () =>
    Date.parse('2026-09-19T09:00:00Z'),
  );
  const before = JSON.stringify(approved);
  expect(await snapshots.review(approved)).toContain('review-needed event');
  expect(await snapshots.review(approved)).not.toContain(
    'New review-needed event',
  );
  const events = [...records.rows.keys()].filter((k) =>
    k.includes('review-event'),
  );
  expect(events).toHaveLength(1);
  expect(JSON.stringify(approved)).toBe(before);
  expect(await snapshots.mute(approved, approved.owner)).toContain('muted');
  await expect(
    snapshots.mute(approved, { ...approved.owner, actorId: 'UOTHER' }),
  ).rejects.toThrow('owner');
});
