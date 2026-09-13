import { expect, it } from 'vitest';
import examples from '../fixtures/contracts/v1/examples.json' with { type: 'json' };
import { DecisionSchema, MeetingSchema } from '../src/contracts/index.js';
import { approvedDecisionSource } from '../src/data/approved-decision.js';
import { MAX_DOCUMENT_CHARACTERS } from '../src/data/chunks.js';
import { validateSourceForIngestion } from '../src/data/sources.js';

function approved() {
  const meeting = MeetingSchema.parse(examples.Meeting);
  const decision = DecisionSchema.parse(examples.Decision);
  decision.state = 'APPROVED';
  decision.approval = {
    actor: decision.owner,
    optionId: decision.options[0]!.optionId,
    approvedRevision: decision.revision - 1,
    approvedAt: '2026-09-12T09:00:00Z',
    rationale:
      'Owner selected the limited pilot pending staffing confirmation.',
  };
  return { meeting, decision: DecisionSchema.parse(decision) };
}

it('indexes an immutable, scoped human choice without inventing measurements or action completion', () => {
  const { decision, meeting } = approved();
  const before = JSON.stringify(decision);
  const source = approvedDecisionSource(decision, meeting);
  expect(validateSourceForIngestion(source)).toEqual(source);
  expect(
    approvedDecisionSource(structuredClone(decision), structuredClone(meeting)),
  ).toEqual(source);
  expect(source).toMatchObject({
    sourceType: 'DECISION',
    workspaceId: decision.workspaceId,
    projectId: decision.projectId,
    revision: decision.revision,
    owner: decision.approval!.actor,
    availableAt: decision.approval!.approvedAt,
    metrics: [],
    synthetic: true,
  });
  expect(source.sourceId.length).toBeLessThanOrEqual(256);
  expect(source.content).toContain(decision.decisionId);
  expect(source.content).toContain(decision.approval!.rationale);
  expect(source.content).toContain('completion is not tracked');
  expect(source.content).toContain('their continued validity is unverified');
  expect(source.content).toContain('proposed owner: unassigned');
  expect(JSON.stringify(decision)).toBe(before);
});

it('rejects unapproved and mismatched meeting records', () => {
  const { decision, meeting } = approved();
  expect(() =>
    approvedDecisionSource(DecisionSchema.parse(examples.Decision), meeting),
  ).toThrow('Only a human-approved');
  expect(() =>
    approvedDecisionSource(decision, {
      ...meeting,
      projectId: 'other-project',
    }),
  ).toThrow('meeting scope');
});

it('bounds context and keeps synthetic evidence visible even in a real meeting', () => {
  const { decision, meeting } = approved();
  meeting.synthetic = false;
  decision.summary = 'Long summary. '.repeat(4_000);
  const source = approvedDecisionSource(decision, meeting);
  expect(source.synthetic).toBe(true);
  expect(source.content.length).toBeLessThanOrEqual(MAX_DOCUMENT_CHARACTERS);
  expect(source.content).toContain('[truncated]');
  decision.evidence.forEach((evidence) => {
    evidence.synthetic = false;
  });
  expect(approvedDecisionSource(decision, meeting).synthetic).toBe(false);
});
