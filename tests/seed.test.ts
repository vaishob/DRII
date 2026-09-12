import { expect, it, vi } from 'vitest';
import { seedDemo } from '../src/data/seed.js';
import type { DecisionStore, SourceStore } from '../src/contracts/services.js';

it('seeds documents, meeting segments and the later reply into the configured Slack scope', async () => {
  const decisions = {
    ingestMeeting: vi.fn<DecisionStore['ingestMeeting']>().mockResolvedValue(),
  };
  const sources = {
    ingestSource: vi.fn<SourceStore['ingestSource']>().mockResolvedValue(),
  };
  expect(
    await seedDemo(decisions, sources, true, {
      workspaceId: 'TREALDEMO',
      projectId: 'actual-launch',
    }),
  ).toEqual({ records: 11, logicalSources: 10 });
  const meeting = decisions.ingestMeeting.mock.calls[0]?.[0];
  expect(meeting?.workspaceId).toBe('TREALDEMO');
  expect(meeting?.segments.every((s) => s.workspaceId === 'TREALDEMO')).toBe(
    true,
  );
  for (const [source] of sources.ingestSource.mock.calls) {
    expect(source.workspaceId).toBe('TREALDEMO');
    expect(source.projectId).toBe('actual-launch');
    expect(source.url.startsWith('drii://TREALDEMO/actual-launch/')).toBe(true);
  }
});
