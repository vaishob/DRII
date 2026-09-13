import { expect, it } from 'vitest';
import examples from '../fixtures/contracts/v1/examples.json' with { type: 'json' };
import { DecisionSchema } from '../src/contracts/index.js';
import { AssumptionMonitor } from '../src/intelligence/monitor.js';
import { DemoSources, MemoryRecords } from './simulation.js';

function setup() {
  const sources = new DemoSources();
  const records = new MemoryRecords();
  const source = sources.sources.find(
    (s) => s.sourceId === 'support-capacity' && s.revision === 1,
  )!;
  const d = DecisionSchema.parse(examples.Decision);
  d.state = 'APPROVED';
  d.approval = {
    actor: d.owner,
    approvedRevision: d.revision - 1,
    optionId: d.options[0]!.optionId,
    approvedAt: '2026-09-12T08:00:00Z',
  };
  d.assumptions[0]!.sourceIds = [source.sourceId];
  d.evidence[0] = {
    ...d.evidence[0]!,
    sourceId: source.sourceId,
    sourceRevision: source.revision,
    excerpt: source.content,
    metrics: structuredClone(source.metrics),
  };
  const monitor = new AssumptionMonitor(sources, records, () =>
    Date.parse('2026-09-19T09:00:00Z'),
  );
  const metric = source.metrics.find((m) => m.name === 'available_agents')!;
  return {
    d: DecisionSchema.parse(d),
    sources,
    source,
    metric,
    records,
    monitor,
    events: () =>
      [...records.rows.keys()].filter((k) => k.includes('review-event')),
  };
}
it('keeps unavailable, mismatched-unit and future metrics unknown; unchanged evidence does not repeat an alert', async () => {
  const h = setup();
  h.metric.value = 3;
  expect(await h.monitor.review(h.d)).toContain('No observed violation');
  h.metric.unit = 'hours';
  expect(await h.monitor.review(h.d)).toContain('UNKNOWN');
  h.metric.unit = 'people';
  h.metric.measuredAt = '2026-09-20T09:00:00Z';
  expect(await h.monitor.review(h.d)).toContain('UNKNOWN');
  expect(h.events()).toHaveLength(0);
  h.metric.measuredAt = '2026-09-19T08:00:00Z';
  h.metric.value = 1;
  expect(await h.monitor.review(h.d)).toContain('New review-needed');
  h.source.content += ' The same condition is described again.';
  h.source.revision++;
  expect(await h.monitor.review(h.d)).not.toContain('New review-needed');
  expect(h.events()).toHaveLength(1);
  h.source.metrics = [];
  expect(await h.monitor.review(h.d)).toContain('UNKNOWN');
  expect(h.events()).toHaveLength(1);
});
it('deduplicates mute delivery and preserves the approved record through dismiss and re-review', async () => {
  const h = setup();
  h.metric.value = 1;
  const before = JSON.stringify(h.d);
  await h.monitor.mute(h.d, h.d.owner, 'delivery-1');
  await h.monitor.mute(h.d, h.d.owner, 'delivery-1');
  expect(await h.monitor.review(h.d)).toContain('muted');
  expect(h.events()).toHaveLength(0);
  await h.monitor.mute(h.d, h.d.owner, 'delivery-2');
  expect(await h.monitor.review(h.d)).toContain('New review-needed');
  await h.monitor.dismiss(h.d, h.d.owner);
  expect(await h.monitor.review(h.d)).not.toContain('New review-needed');
  expect(h.events()).toHaveLength(1);
  expect(JSON.stringify(h.d)).toBe(before);
});
it('detects replaced nonmetric evidence without declaring an unknown threshold violated', async () => {
  const h = setup();
  h.d.assumptions[0]!.metric = null;
  h.source.revision++;
  h.source.content =
    'This support plan has been replaced; capacity is not yet measured.';
  const observed = await h.monitor.inspect(h.d, '2026-09-19T09:00:00Z');
  expect(observed[0]?.status).toBe('SUPERSEDED');
  expect(observed[0]?.value).toBeNull();
});
it('evaluates the latest measurement in unordered history and does not fall back after its unit changes', async () => {
  const h = setup();
  const older = { ...h.metric, value: 3, measuredAt: '2026-09-18T08:00:00Z' };
  const current = { ...h.metric, value: 1, measuredAt: '2026-09-19T08:00:00Z' };
  const future = { ...h.metric, value: 3, measuredAt: '2026-09-20T08:00:00Z' };
  for (const metrics of [
    [older, current, future],
    [future, current, older],
  ]) {
    h.source.metrics = metrics;
    const observed = await h.monitor.inspect(h.d, '2026-09-19T09:00:00Z');
    expect(observed[0]).toMatchObject({
      status: 'VIOLATED',
      value: 1,
      sourceTime: current.measuredAt,
    });
  }
  current.unit = 'hours';
  expect(
    (await h.monitor.inspect(h.d, '2026-09-19T09:00:00Z'))[0],
  ).toMatchObject({ status: 'UNKNOWN', value: null });
});
it('keeps contradictory measurements at the same time unknown instead of choosing arbitrary evidence', async () => {
  const h = setup();
  h.source.metrics = [h.metric, { ...h.metric, value: h.metric.value + 2 }];
  const observed = await h.monitor.inspect(h.d, '2026-09-19T09:00:00Z');
  expect(observed[0]).toMatchObject({ status: 'UNKNOWN', value: null });
});
