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
  type Source,
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
    criterionAssessments: [
      {
        optionId: 'pilot',
        criterionId: 'criterion-1',
        assessment: 'Support capacity requires verification.',
        citations: [],
      },
      {
        optionId: 'broad',
        criterionId: 'criterion-1',
        assessment:
          'The broad scope exceeds the currently verified support capacity.',
        citations: [],
      },
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
        (x) =>
          x.meetingId === m.meetingId &&
          x.workspaceId === m.workspaceId &&
          x.revision === m.revision,
      )
    )
      this.meetings.push(structuredClone(m));
  }
  async getMeeting(w: string, id: string) {
    return structuredClone(
      this.meetings
        .filter((m) => m.workspaceId === w && m.meetingId === id)
        .sort((a, b) => b.revision - a.revision)[0] ?? null,
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
  it('retrieves decision context even when a choice contains priorities but no factual claim', async () => {
    const h = harness();
    const prioritiesOnly = { ...extraction, claims: [] };
    const assessment = { ...review(), checks: [] };
    vi.spyOn(h.model, 'generate')
      .mockResolvedValueOnce(prioritiesOnly)
      .mockResolvedValueOnce(assessment)
      .mockResolvedValueOnce(assessment);
    const result = await h.workflow.analyzeDecision(meeting);
    expect(result.state).toBe('NEEDS_INPUT');
    expect(h.retriever.retrieveEvidence).toHaveBeenCalledWith(
      extraction.question,
      expect.objectContaining({
        workspaceId: meeting.workspaceId,
        projectId: meeting.projectId,
      }),
    );
    expect(result.evidence).toHaveLength(1);
  });
  it('requires a complete unweighted option/criterion matrix and exact citations', () => {
    const missing = review();
    missing.criterionAssessments!.pop();
    expect(() => validateReview(missing, extraction, [evidence(1)])).toThrow(
      'every shared criterion',
    );
    const duplicate = review();
    duplicate.criterionAssessments![1] = duplicate.criterionAssessments![0]!;
    expect(() => validateReview(duplicate, extraction, [evidence(1)])).toThrow(
      'duplicate',
    );
    const fabricated = review();
    fabricated.criterionAssessments![0]!.citations = [
      { evidenceId: 'qa-0', quote: 'Everyone agreed.' },
    ];
    expect(() => validateReview(fabricated, extraction, [evidence(1)])).toThrow(
      'Fabricated citation',
    );
  });
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
  it.each([false, true])(
    'keeps a confirmed stakeholder question correlated during re-review (provider failure=%s)',
    async (providerFailure) => {
      const h = harness();
      const first = await h.workflow.ingestMeeting(meeting);
      const target = { actorId: 'noor', displayName: 'Noor', role: 'Support' };
      const confirmed = await h.workflow.confirmFollowUp(
        meeting.workspaceId,
        first.decisionId,
        first.revision,
        meeting.owner,
        target,
      );
      if (providerFailure)
        vi.spyOn(h.model, 'generate').mockRejectedValueOnce(
          new Error('temporary model outage'),
        );
      const challenged = await h.workflow.challengeDecision(
        meeting.workspaceId,
        first.decisionId,
        confirmed.revision,
      );
      expect(challenged.state).toBe(providerFailure ? 'FAILED' : 'NEEDS_INPUT');
      expect(
        challenged.followUps.filter((f) => f.status !== 'ANSWERED'),
      ).toEqual([confirmed.followUps[0]]);
      const resumed = await h.workflow.resumeWithEvidence(
        meeting.workspaceId,
        first.decisionId,
        confirmed.followUps[0]!.questionId,
        {
          actor: target,
          text: 'Two agents can cover this pilot.',
          receivedAt: '2026-09-12T08:10:00.000Z',
          sourceId: 'reply-after-review',
        },
      );
      expect(resumed.state).toBe('READY_FOR_REVIEW');
      expect(resumed.failure).toBeNull();
      expect(
        resumed.followUps.filter((f) => f.status === 'ANSWERED'),
      ).toHaveLength(1);
    },
  );
  it('keeps approval saved through an indexing outage and retries searchable context idempotently', async () => {
    const h = harness();
    vi.spyOn(h.model, 'generate')
      .mockResolvedValueOnce(extraction)
      .mockResolvedValueOnce(review(true))
      .mockResolvedValueOnce(review(true));
    const ready = await h.workflow.ingestMeeting(meeting);
    expect(ready.state).toBe('READY_FOR_REVIEW');
    await expect(h.workflow.indexApprovedDecision(ready)).rejects.toThrow(
      'saved approval',
    );
    const ingest = vi
      .mocked(h.sourceStore.ingestSource)
      .mockRejectedValue(new Error('embedding outage'));
    const approved = await h.workflow.approveDecision(
      meeting.workspaceId,
      ready.decisionId,
      ready.revision,
      meeting.owner,
      'pilot',
    );
    expect(approved.state).toBe('APPROVED');
    expect(await h.workflow.get(meeting.workspaceId, ready.decisionId)).toEqual(
      approved,
    );
    await expect(h.workflow.indexApprovedDecision(approved)).rejects.toThrow(
      'embedding outage',
    );
    let indexed: Source | null = null;
    ingest.mockImplementation(async (source) => {
      indexed = structuredClone(source);
    });
    vi.mocked(h.sourceStore.getSource).mockImplementation(async () => indexed);
    const eventCount = h.store.events.length;
    await h.workflow.indexApprovedDecision(approved);
    expect(indexed).toMatchObject({
      sourceType: 'DECISION',
      revision: approved.revision,
      metrics: [],
      owner: meeting.owner,
    });
    expect(indexed!.content).toContain('does not verify underlying claims');
    const writes = ingest.mock.calls.length;
    await h.workflow.indexApprovedDecision(approved);
    await h.workflow.approveDecision(
      meeting.workspaceId,
      approved.decisionId,
      ready.revision,
      meeting.owner,
      'pilot',
    );
    expect(ingest).toHaveBeenCalledTimes(writes);
    expect(h.store.events).toHaveLength(eventCount);
  });
  it('preserves unknown-speaker priorities as exact sourced shared criteria without inventing weights', async () => {
    const h = harness();
    const unknown = structuredClone(meeting);
    unknown.segments[0]!.speaker = null;
    unknown.segments[0]!.speakerLabel = 'Speaker 1';
    const result = await h.workflow.ingestMeeting(unknown);
    expect(result.state).toBe('NEEDS_INPUT');
    expect(result.priorities).toEqual([
      expect.objectContaining({
        actor: null,
        weight: null,
        weightConfirmed: false,
      }),
    ]);
    expect(result.analysis?.criteria).toEqual([
      expect.objectContaining({
        id: 'criterion-1',
        speakerLabel: 'Speaker 1',
        quote: extraction.priorities[0]!.quote,
        kind: 'CONSTRAINT',
      }),
    ]);
    expect(result.analysis?.review?.criterionAssessments).toHaveLength(2);
  });
  it('keeps an attributed reply citable even when RAG does not return it and explains changed recommendation conditions', async () => {
    const h = harness();
    const generated = vi.spyOn(h.model, 'generate');
    const first = await h.workflow.ingestMeeting(meeting);
    const target = { actorId: 'noor', displayName: 'Noor', role: 'Support' };
    const confirmed = await h.workflow.confirmFollowUp(
      meeting.workspaceId,
      first.decisionId,
      first.revision,
      meeting.owner,
      target,
    );
    const answer = {
      actor: target,
      text: 'Two agents can cover the pilot; this is my current estimate.',
      receivedAt: '2026-09-12T08:10:00.000Z',
      sourceId: 'not-found-by-similarity',
    };
    const ready = await h.workflow.resumeWithEvidence(
      meeting.workspaceId,
      first.decisionId,
      confirmed.followUps[0]!.questionId,
      answer,
    );
    expect(ready.state).toBe('READY_FOR_REVIEW');
    const cited = ready.evidence.find((e) => e.sourceId === answer.sourceId);
    expect(cited).toMatchObject({
      excerpt: answer.text,
      sourceType: 'FOLLOW_UP',
      sourceDate: answer.receivedAt,
      owner: target,
      metrics: [],
      relevance: { method: 'DIRECT' },
    });
    const modelInput = generated.mock.calls.findLast(
      (call) => call[0] === 'red_team_review',
    )?.[3] as { evidence: Evidence[] };
    expect(modelInput.evidence).toContainEqual(cited);
    const changed = ready.findings.find((f) => f.kind === 'CHANGE');
    expect(changed?.text).toContain(
      'Added condition: Coverage confirmed by participant; verify before rollout.',
    );
    expect(changed?.evidenceIds).toContain(cited?.evidenceId);
    expect(ready.sourceIds).toContain(answer.sourceId);
    await expect(
      h.workflow.approveDecision(
        meeting.workspaceId,
        ready.decisionId,
        ready.revision,
        meeting.owner,
        'broad',
      ),
    ).rejects.toThrow('reviewed action plan');
    expect(
      (await h.workflow.get(meeting.workspaceId, ready.decisionId)).state,
    ).toBe('READY_FOR_REVIEW');
  });
  it('re-extracts the latest stored transcript after a correction is saved but review startup is interrupted', async () => {
    const h = harness();
    const first = await h.workflow.ingestMeeting(meeting);
    const append = vi
      .spyOn(h.store, 'appendDecisionEvent')
      .mockRejectedValueOnce(new Error('interrupted review startup'));
    await expect(
      h.workflow.correctMeeting(
        meeting.workspaceId,
        first.decisionId,
        first.revision,
        meeting.owner,
        {
          segmentId: 'launch-segment-2',
          speaker: null,
          text: 'The QA report still has unresolved blockers.',
        },
      ),
    ).rejects.toThrow('interrupted');
    append.mockRestore();
    const amended = structuredClone(extraction);
    amended.claims[0]!.text = 'The QA report has unresolved blockers';
    amended.claims[0]!.references = [
      { segmentId: 'launch-segment-2', quote: 'unresolved blockers' },
    ];
    const generate = vi
      .spyOn(h.model, 'generate')
      .mockResolvedValueOnce(amended);
    const retried = await h.workflow.challengeDecision(
      meeting.workspaceId,
      first.decisionId,
      first.revision,
    );
    expect(generate.mock.calls[0]?.[0]).toBe('decision_extraction');
    expect(retried.state).toBe('NEEDS_INPUT');
    expect(retried.analysis?.meetingRevision).toBe(1);
    expect(retried.claims[0]?.text).toBe(
      'The QA report has unresolved blockers',
    );
  });
  it.each([false, true])(
    'resumes an interrupted attributed reply (clarification=%s)',
    async (clarification) => {
      const h = harness();
      const generate = vi.spyOn(h.model, 'generate');
      if (clarification)
        generate.mockResolvedValueOnce({
          ...extraction,
          question: null,
          options: [],
          claims: [],
          clarification: 'Which choice needs a review?',
        });
      const first = await h.workflow.ingestMeeting(meeting);
      const target = { actorId: 'noor', displayName: 'Noor', role: 'Support' };
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
        text: 'Decide on the pilot; support can cover it.',
        sourceId: 'interrupted-reply',
        receivedAt: '2026-09-12T09:00:00Z',
      };
      const append = h.store.appendDecisionEvent.bind(h.store);
      const crash = vi
        .spyOn(h.store, 'appendDecisionEvent')
        .mockImplementationOnce(append)
        .mockRejectedValueOnce(
          new Error('simulated interrupted analysis write'),
        );
      await expect(
        h.workflow.resumeWithEvidence(
          meeting.workspaceId,
          first.decisionId,
          questionId,
          answer,
        ),
      ).rejects.toThrow('interrupted');
      crash.mockRestore();
      const recovered = await h.workflow.resumeWithEvidence(
        meeting.workspaceId,
        first.decisionId,
        questionId,
        answer,
      );
      expect(recovered.state).toBe('READY_FOR_REVIEW');
      expect(recovered.approval).toBeNull();
      expect(
        recovered.followUps.filter(
          (f) => f.answer?.sourceId === answer.sourceId,
        ),
      ).toHaveLength(1);
      if (clarification)
        expect(
          (
            await h.store.getMeeting(meeting.workspaceId, meeting.meetingId)
          )?.segments.filter((s) => s.segmentId === answer.sourceId),
        ).toHaveLength(1);
      expect(generate.mock.calls.some((c) => c[0] === 'red_team_review')).toBe(
        true,
      );
    },
  );
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
