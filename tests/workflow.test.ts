import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import rawMeeting from '../fixtures/demo/meeting.json' with { type: 'json' };
import {
  DecisionEventSchema,
  MeetingSchema,
  type Decision,
  type DecisionEvent,
  type Evidence,
  type Meeting,
} from '../src/contracts/index.js';
import type {
  DecisionStore,
  SourceStore,
  EvidenceRetriever,
} from '../src/contracts/services.js';
import {
  DecisionEngine,
  validateExtraction,
  validateReview,
} from '../src/intelligence/engine.js';
import { DurableDecisionWorkflow } from '../src/intelligence/workflow.js';
import type { ReasoningModel } from '../src/intelligence/model.js';
import type { Extraction, Review } from '../src/intelligence/schema.js';

const meeting = MeetingSchema.parse(rawMeeting);
const extraction: Extraction = {
  summary: 'Choose a safe launch scope.',
  question: 'Broad launch or pilot?',
  options: [
    {
      id: 'pilot',
      title: 'Pilot',
      description: 'Ten customers, billing disabled',
    },
    { id: 'broad', title: 'Broad launch', description: 'All customers' },
  ],
  claims: [
    {
      id: 'bugs',
      text: 'All blocking bugs are fixed',
      references: [
        {
          segmentId: 'launch-segment-2',
          quote: 'all blocking bugs were fixed',
        },
      ],
    },
  ],
  priorities: [
    {
      description: 'Avoid more risk than support can handle',
      segmentId: 'launch-segment-1',
      quote: 'without taking on more risk than we can support',
      kind: 'CONSTRAINT',
      inferred: false,
    },
  ],
  disagreements: [
    'Sales wants Friday availability; engineering requires verification.',
  ],
  clarification: null,
};
const evidence = (revision: number): Evidence => ({
  schemaVersion: '1.0',
  workspaceId: meeting.workspaceId,
  decisionId: meeting.meetingId,
  revision,
  createdAt: meeting.createdAt,
  sourceIds: ['qa'],
  evidenceId: 'qa-0',
  sourceId: 'qa',
  sourceRevision: 0,
  chunkId: 'qa-chunk',
  excerpt: 'Two blocking bugs remain unresolved.',
  sourceTitle: 'QA report',
  sourceType: 'ENGINEERING',
  sourceDate: meeting.createdAt,
  sourceUrl: 'drii://demo-workspace/launch/qa',
  owner: meeting.owner,
  synthetic: true,
  metrics: [],
  relevance: { method: 'KEYWORD', score: 1, model: null },
});
function review(answered = false): Review {
  return {
    checks: [
      {
        claimId: 'bugs',
        status: 'CONTRADICTED',
        explanation: 'The dated QA report still lists two blockers.',
        citations: [
          { evidenceId: 'qa-0', quote: 'Two blocking bugs remain unresolved.' },
        ],
      },
    ],
    objection: {
      text: 'Broad launch exposes customers to known bugs.',
      citations: [{ evidenceId: 'qa-0', quote: 'Two blocking bugs' }],
      wouldChangeAssessment: 'A verified passing regression run.',
    },
    additionalQueries: [],
    comparison: [
      { optionId: 'pilot', assessment: 'Conditional on coverage' },
      { optionId: 'broad', assessment: 'Blocked' },
    ],
    recommendation: {
      optionId: 'pilot',
      conditions: [
        answered
          ? 'Coverage confirmed by participant; verify before rollout.'
          : 'Ask Support about coverage.',
      ],
    },
    question: answered
      ? null
      : { text: 'Can Support cover the pilot?', role: 'Support' },
    actions: [
      {
        id: 'verify',
        description: 'Verify coverage before rollout',
        dependsOn: [],
        proposedOwner: null,
        dueAt: null,
      },
    ],
    assumptions: [
      {
        id: 'coverage',
        text: 'Support capacity remains sufficient',
        sourceId: 'qa',
        metricName: null,
        operator: null,
        threshold: null,
        unit: null,
        proposedOwner: null,
        reviewAt: null,
      },
    ],
  };
}

export class TestDecisionStore implements DecisionStore {
  readonly events: DecisionEvent[] = [];
  readonly meetings: Meeting[] = [];
  async ingestMeeting(m: Meeting) {
    if (
      !this.meetings.some(
        (x) => x.meetingId === m.meetingId && x.workspaceId === m.workspaceId,
      )
    )
      this.meetings.push(structuredClone(m));
  }
  async getMeeting(w: string, id: string) {
    return structuredClone(
      this.meetings.find((m) => m.workspaceId === w && m.meetingId === id) ??
        null,
    );
  }
  async getDecision(w: string, id: string): Promise<Decision | null> {
    return structuredClone(
      this.events
        .filter((e) => e.workspaceId === w && e.decisionId === id)
        .sort((a, b) => b.revision - a.revision)[0]?.decision ?? null,
    );
  }
  async getEventByDeduplicationId(w: string, id: string, dedup: string) {
    return (
      this.events.find(
        (e) =>
          e.workspaceId === w &&
          e.decisionId === id &&
          e.deduplicationId === dedup,
      ) ?? null
    );
  }
  async appendDecisionEvent(e: DecisionEvent) {
    const parsed = DecisionEventSchema.parse(e);
    if (
      this.events.some(
        (x) =>
          x.workspaceId === e.workspaceId &&
          x.decisionId === e.decisionId &&
          x.revision === e.revision,
      )
    )
      throw new Error('Duplicate revision');
    this.events.push(structuredClone(parsed));
  }
}
function harness() {
  const store = new TestDecisionStore();
  const sourceStore: SourceStore = {
    ingestSource: vi.fn<SourceStore['ingestSource']>().mockResolvedValue(),
    getSource: vi.fn<SourceStore['getSource']>().mockResolvedValue(null),
  };
  const retriever: EvidenceRetriever = {
    retrieveEvidence: vi
      .fn<EvidenceRetriever['retrieveEvidence']>()
      .mockImplementation(async (_, scope) => ({
        status: 'FOUND',
        evidence: [evidence(scope.revision)],
      })),
  };
  const model: ReasoningModel = {
    name: 'deterministic-test-double',
    async generate<T>(
      stage: string,
      schema: z.ZodType<T>,
      _instruction: string,
      data: unknown,
      validate: (r: T) => void,
    ) {
      const result = schema.parse(
        stage === 'decision_extraction'
          ? extraction
          : review(JSON.stringify(data).includes('"ANSWERED"')),
      );
      validate(result);
      return result;
    },
  };
  const engine = new DecisionEngine(model, retriever);
  const workflow = new DurableDecisionWorkflow(
    store,
    sourceStore,
    engine,
    () => '2026-09-12T09:00:00.000Z',
  );
  return { store, sourceStore, retriever, model, engine, workflow };
}

describe('reasoning evidence boundaries', () => {
  it('rejects fabricated transcript quotes and unknown claim citations', () => {
    expect(() =>
      validateExtraction(
        {
          ...extraction,
          claims: [
            {
              ...extraction.claims[0]!,
              references: [{ segmentId: 'missing', quote: 'approved' }],
            },
          ],
        },
        meeting,
      ),
    ).toThrow();
    const bad = review();
    bad.checks[0]!.citations[0]!.evidenceId = 'invented';
    expect(() => validateReview(bad, extraction, [evidence(1)])).toThrow(
      'Fabricated',
    );
  });
  it('does not allow supported or contradicted claims without evidence', () => {
    const bad = review();
    bad.checks[0]!.citations = [];
    expect(() => validateReview(bad, extraction, [])).toThrow(
      'requires evidence',
    );
    bad.checks[0]!.status = 'INSUFFICIENT_EVIDENCE';
    bad.objection.citations = [];
    bad.assumptions = [];
    expect(() => validateReview(bad, extraction, [])).not.toThrow();
  });
  it('rejects forward/cyclic action dependencies and duplicate checks', () => {
    const bad = review();
    bad.actions[0]!.dependsOn = ['later'];
    expect(() => validateReview(bad, extraction, [evidence(1)])).toThrow(
      'dependencies',
    );
    bad.actions[0]!.dependsOn = [];
    bad.checks.push(bad.checks[0]!);
    expect(() => validateReview(bad, extraction, [evidence(1)])).toThrow(
      'exactly once',
    );
  });
});

describe('durable human decision workflow', () => {
  it('persists the full loop, rejects wrong actors/stale actions and keeps approval immutable', async () => {
    const h = harness();
    const first = await h.workflow.ingestMeeting(meeting);
    expect(first.state).toBe('NEEDS_INPUT');
    expect(first.claims[0]?.status).toBe('CONTRADICTED');
    expect(first.approval).toBeNull();
    const count = h.store.events.length;
    await h.workflow.ingestMeeting(meeting);
    expect(h.store.events).toHaveLength(count);
    const target = { actorId: 'noor', displayName: 'Noor', role: 'Support' };
    await expect(
      h.workflow.confirmFollowUp(
        meeting.workspaceId,
        first.decisionId,
        first.revision,
        target,
        target,
      ),
    ).rejects.toThrow('owner');
    const confirmed = await h.workflow.confirmFollowUp(
      meeting.workspaceId,
      first.decisionId,
      first.revision,
      meeting.owner,
      target,
    );
    const questionId = confirmed.followUps[0]!.questionId;
    const answer = {
      actor: target,
      text: 'Two agents can cover the pilot.',
      receivedAt: '2026-09-12T08:10:00.000Z',
      sourceId: 'reply-1',
    };
    await expect(
      h.workflow.resumeWithEvidence(
        meeting.workspaceId,
        first.decisionId,
        questionId,
        { ...answer, actor: meeting.owner },
      ),
    ).rejects.toThrow('participant');
    const resumed = new DurableDecisionWorkflow(
      h.store,
      h.sourceStore,
      h.engine,
    );
    const ready = await resumed.resumeWithEvidence(
      meeting.workspaceId,
      first.decisionId,
      questionId,
      answer,
    );
    expect(ready.state).toBe('READY_FOR_REVIEW');
    expect(h.sourceStore.ingestSource).toHaveBeenCalledWith(
      expect.objectContaining({ content: answer.text, metrics: [] }),
    );
    expect(
      await resumed.resumeWithEvidence(
        meeting.workspaceId,
        first.decisionId,
        questionId,
        answer,
      ),
    ).toEqual(ready);
    await expect(
      resumed.approveDecision(
        meeting.workspaceId,
        first.decisionId,
        ready.revision,
        target,
        'pilot',
      ),
    ).rejects.toThrow('owner');
    await expect(
      resumed.approveDecision(
        meeting.workspaceId,
        first.decisionId,
        first.revision,
        meeting.owner,
        'pilot',
      ),
    ).rejects.toThrow('changed');
    const approved = await resumed.approveDecision(
      meeting.workspaceId,
      first.decisionId,
      ready.revision,
      meeting.owner,
      'pilot',
    );
    expect(approved.approval?.approvedRevision).toBe(ready.revision);
    expect(
      await resumed.approveDecision(
        meeting.workspaceId,
        first.decisionId,
        ready.revision,
        meeting.owner,
        'pilot',
      ),
    ).toEqual(approved);
    await expect(
      resumed.resumeWithEvidence(
        meeting.workspaceId,
        first.decisionId,
        questionId,
        { ...answer, sourceId: 'late-reply' },
      ),
    ).rejects.toThrow('finalized');
    expect(await resumed.get(meeting.workspaceId, first.decisionId)).toEqual(
      approved,
    );
    await expect(
      resumed.get('another-workspace', first.decisionId),
    ).rejects.toThrow('unavailable');
  });
  it('records recoverable failure and supports explicit retry without inventing approval', async () => {
    const h = harness();
    vi.spyOn(h.model, 'generate').mockRejectedValueOnce(
      new Error('provider-secret'),
    );
    const failed = await h.workflow.ingestMeeting(meeting);
    expect(failed.state).toBe('FAILED');
    expect(JSON.stringify(failed)).not.toContain('provider-secret');
    const retried = await h.workflow.challengeDecision(
      meeting.workspaceId,
      failed.decisionId,
      failed.revision,
    );
    expect(retried.state).toBe('NEEDS_INPUT');
    expect(retried.approval).toBeNull();
  });
});
