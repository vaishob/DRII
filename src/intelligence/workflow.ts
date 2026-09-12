import { createHash } from 'node:crypto';
import {
  DecisionSchema,
  DecisionEventSchema,
  MeetingSchema,
  SCHEMA_VERSION,
  type Actor,
  type Decision,
  type DecisionEvent,
  type FollowUp,
  type Meeting,
  type Source,
} from '../contracts/index.js';
import type { DecisionStore, SourceStore } from '../contracts/services.js';
import { DecisionQueue } from '../data/queue.js';
import type { DecisionEngine } from './engine.js';

const queue = new DecisionQueue();
export function stableId(...parts: string[]): string {
  return createHash('sha256')
    .update(JSON.stringify(parts))
    .digest('hex')
    .slice(0, 32);
}
export class WorkflowError extends Error {}
export class DurableDecisionWorkflow {
  constructor(
    readonly store: DecisionStore,
    private readonly sources: SourceStore,
    private readonly engine: DecisionEngine,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private async record(
    decision: Decision,
    eventType: DecisionEvent['eventType'],
    deduplicationId: string,
    actor: Actor | null = null,
  ): Promise<Decision> {
    const checked = DecisionSchema.parse(decision);
    await this.store.appendDecisionEvent(
      DecisionEventSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        workspaceId: checked.workspaceId,
        decisionId: checked.decisionId,
        meetingId: checked.meetingId,
        revision: checked.revision,
        sourceIds: checked.sourceIds,
        createdAt: this.now(),
        eventId: stableId(
          checked.workspaceId,
          checked.decisionId,
          deduplicationId,
        ),
        deduplicationId,
        eventType,
        actor,
        decision: checked,
      }),
    );
    return checked;
  }
  async get(workspace: string, id: string): Promise<Decision> {
    const current = await this.store.getDecision(workspace, id);
    if (!current)
      throw new WorkflowError('Decision unavailable in this workspace.');
    return current;
  }
  private check(current: Decision, revision: number): void {
    if (current.revision !== revision)
      throw new WorkflowError(
        'This review has changed. Refresh the card before acting.',
      );
  }
  private owner(current: Decision, actor: Actor): void {
    if (actor.actorId !== current.owner.actorId)
      throw new WorkflowError(
        'Only the configured decision owner can perform this action.',
      );
  }
  async ingestMeeting(input: Meeting): Promise<Decision> {
    const meeting = MeetingSchema.parse(input);
    return queue.run(meeting.workspaceId, meeting.meetingId, async () => {
      const existing = await this.store.getDecision(
        meeting.workspaceId,
        meeting.meetingId,
      );
      if (
        existing &&
        !['RECEIVED', 'ANALYZING', 'FAILED'].includes(existing.state)
      )
        return existing;
      await this.store.ingestMeeting(meeting);
      const initial =
        existing ??
        (await this.record(
          DecisionSchema.parse({
            schemaVersion: SCHEMA_VERSION,
            workspaceId: meeting.workspaceId,
            decisionId: meeting.meetingId,
            meetingId: meeting.meetingId,
            projectId: meeting.projectId,
            revision: 0,
            createdAt: meeting.createdAt,
            sourceIds: meeting.sourceIds,
            owner: meeting.owner,
            title: meeting.title,
            summary: '',
            state: 'RECEIVED',
            options: [],
            claims: [],
            evidence: [],
            priorities: [],
            findings: [],
            followUps: [],
            actions: [],
            assumptions: [],
            recommendedOptionId: null,
            approval: null,
            failure: null,
          }),
          'RECEIVED',
          'received',
        ));
      return this.review(initial, meeting, `initial:${initial.revision}`);
    });
  }
  private async review(
    current: Decision,
    meeting: Meeting,
    key: string,
  ): Promise<Decision> {
    const started = await this.record(
      {
        ...current,
        revision: current.revision + 1,
        state: 'ANALYZING',
        approval: null,
        failure: null,
      },
      'ANALYSIS_STARTED',
      key + ':start',
    );
    try {
      const { analysis, evidence } = await this.engine.analyze(
        meeting,
        started,
        this.now(),
      );
      const revision = started.revision + 1;
      const fields = {
        schemaVersion: SCHEMA_VERSION,
        workspaceId: current.workspaceId,
        decisionId: current.decisionId,
        revision,
        createdAt: this.now(),
        sourceIds: [] as string[],
      };
      const { extraction, review } = analysis;
      const question =
        review?.question?.text ??
        (!extraction.question ? extraction.clarification : null);
      const nextQuestion = question
        ? {
            ...fields,
            questionId: stableId(
              current.decisionId,
              String(revision),
              question,
            ),
            question: `${review?.question?.role ? `[${review.question.role}] ` : ''}${question}`,
            target: null,
            status: 'PROPOSED' as const,
            answer: null,
          }
        : null;
      const completed = DecisionSchema.parse({
        ...started,
        revision,
        title: extraction.question ?? 'Clarification needed',
        summary: extraction.summary,
        analysis,
        evidence,
        state: question ? 'NEEDS_INPUT' : 'READY_FOR_REVIEW',
        options: extraction.options.map((o) => ({
          ...fields,
          optionId: o.id,
          title: o.title,
          description: o.description,
        })),
        claims: extraction.claims.map((c) => {
          const checked = review?.checks.find((x) => x.claimId === c.id);
          return {
            ...fields,
            claimId: c.id,
            sourceIds: c.references.map((r) => r.segmentId),
            text: c.text,
            speaker:
              meeting.segments.find(
                (s) => s.segmentId === c.references[0]?.segmentId,
              )?.speaker ?? null,
            status: checked?.status ?? 'INSUFFICIENT_EVIDENCE',
            evidenceIds: checked?.citations.map((e) => e.evidenceId) ?? [],
            explanation: checked?.explanation ?? 'Evidence not checked.',
          };
        }),
        priorities: extraction.priorities
          .filter(
            (p) =>
              meeting.segments.find((s) => s.segmentId === p.segmentId)
                ?.speaker,
          )
          .map((p) => ({
            actor: meeting.segments.find((s) => s.segmentId === p.segmentId)
              ?.speaker,
            description: `${p.kind}${p.inferred ? ' (inferred)' : ''}: ${p.description}`,
            weight: null,
            weightConfirmed: false,
          })),
        findings: review
          ? [
              {
                findingId: 'objection',
                kind: 'OBJECTION',
                text: `${review.objection.text} Evidence that would change this: ${review.objection.wouldChangeAssessment}`,
                evidenceIds: review.objection.citations.map(
                  (c) => c.evidenceId,
                ),
              },
              ...(current.analysis?.review
                ? [
                    {
                      findingId: 'changed',
                      kind: 'CHANGE',
                      text: this.changes(current, review.checks),
                      evidenceIds: [],
                    },
                  ]
                : []),
            ]
          : [],
        followUps: [
          ...started.followUps.filter((f) => f.status === 'ANSWERED'),
          ...(nextQuestion ? [nextQuestion] : []),
        ],
        actions:
          review?.actions.map((a, i) => ({
            ...fields,
            actionId: a.id,
            order: i + 1,
            description: `${a.description}${a.dependsOn.length ? ` (after ${a.dependsOn.join(', ')})` : ''}${a.proposedOwner ? `; proposed owner: ${a.proposedOwner}` : '; owner unassigned'}`,
            owner: null,
            dueAt: a.dueAt ? new Date(a.dueAt).toISOString() : null,
          })) ?? [],
        assumptions:
          review?.assumptions.map((a) => ({
            ...fields,
            assumptionId: a.id,
            text: a.text,
            sourceIds: a.sourceId ? [a.sourceId] : [],
            status: 'UNKNOWN',
            metric:
              a.metricName !== null &&
              a.operator !== null &&
              a.threshold !== null &&
              a.unit !== null
                ? {
                    name: a.metricName,
                    operator: a.operator,
                    threshold: a.threshold,
                    unit: a.unit,
                  }
                : null,
          })) ?? [],
        recommendedOptionId: review?.recommendation.optionId ?? null,
      });
      return await this.record(
        completed,
        completed.state === 'NEEDS_INPUT' ? 'INPUT_REQUESTED' : 'REVIEW_READY',
        key + ':done',
      );
    } catch {
      return this.record(
        {
          ...started,
          revision: started.revision + 1,
          state: 'FAILED',
          failure: {
            code: 'REVIEW_FAILED',
            message:
              'Review or validation failed. Retry the current decision; no approval was recorded.',
            retryable: true,
          },
        },
        'FAILED',
        key + ':failed',
      );
    }
  }
  private changes(
    previous: Decision,
    checks: { claimId: string; status: string; explanation: string }[],
  ): string {
    const changed = checks.filter((c) => {
      const old = previous.claims.find((x) => x.claimId === c.claimId);
      return old?.status !== c.status || old?.explanation !== c.explanation;
    });
    return changed.length
      ? changed
          .map(
            (c) =>
              `${c.claimId}: ${previous.claims.find((x) => x.claimId === c.claimId)?.status ?? 'unchecked'} → ${c.status}. ${c.explanation}`,
          )
          .join('\n')
      : 'No claim status or explanation changed. Inspect the updated recommendation conditions.';
  }
  async challengeDecision(
    workspace: string,
    id: string,
    revision: number,
  ): Promise<Decision> {
    return queue.run(workspace, id, async () => {
      const current = await this.get(workspace, id);
      this.check(current, revision);
      if (current.state === 'APPROVED')
        throw new WorkflowError(
          'Approved decisions are immutable. Start a new review to reconsider them.',
        );
      const meeting = await this.store.getMeeting(workspace, current.meetingId);
      if (!meeting) throw new WorkflowError('Stored transcript unavailable.');
      return this.review(current, meeting, `challenge:${revision}`);
    });
  }
  async confirmFollowUp(
    workspace: string,
    id: string,
    revision: number,
    actor: Actor,
    target: Actor,
  ): Promise<Decision> {
    return queue.run(workspace, id, async () => {
      const current = await this.get(workspace, id);
      this.check(current, revision);
      this.owner(current, actor);
      const question = current.followUps.find((f) => f.status === 'PROPOSED');
      if (current.state !== 'NEEDS_INPUT' || !question)
        throw new WorkflowError('No pending follow-up to send.');
      return this.record(
        {
          ...current,
          revision: revision + 1,
          followUps: current.followUps.map((f) =>
            f.questionId === question.questionId
              ? { ...f, target, status: 'CONFIRMED' }
              : f,
          ),
        },
        'FOLLOW_UP_CONFIRMED',
        `confirm:${revision}`,
        actor,
      );
    });
  }
  async resumeWithEvidence(
    workspace: string,
    id: string,
    questionId: string,
    answer: NonNullable<FollowUp['answer']>,
  ): Promise<Decision> {
    return queue.run(workspace, id, async () => {
      const current = await this.get(workspace, id);
      const question = current.followUps.find(
        (f) => f.questionId === questionId,
      );
      if (question?.answer?.sourceId === answer.sourceId) {
        if (
          question.answer.text !== answer.text ||
          question.answer.actor.actorId !== answer.actor.actorId
        )
          throw new WorkflowError(
            'A reply ID cannot be reused with different content or actor.',
          );
        if (
          ['ANALYZING', 'FAILED', 'NEEDS_INPUT'].includes(current.state) &&
          !current.followUps.some((f) => f.status !== 'ANSWERED')
        ) {
          const stored = await this.store.getMeeting(
            workspace,
            current.meetingId,
          );
          if (!stored)
            throw new WorkflowError('Stored transcript unavailable.');
          return this.resumeReview(
            current,
            stored,
            answer,
            `resume-retry:${current.revision}:${answer.sourceId}`,
          );
        }
        return current;
      }
      if (
        current.state !== 'NEEDS_INPUT' ||
        question?.status !== 'CONFIRMED' ||
        question.target?.actorId !== answer.actor.actorId
      )
        throw new WorkflowError(
          'Reply does not match the pending participant/question, or the decision is already finalized.',
        );
      const meeting = await this.store.getMeeting(workspace, current.meetingId);
      if (!meeting) throw new WorkflowError('Stored transcript unavailable.');
      const source: Source = {
        schemaVersion: SCHEMA_VERSION,
        workspaceId: workspace,
        sourceId: answer.sourceId,
        projectId: current.projectId,
        revision: 0,
        createdAt: answer.receivedAt,
        sourceIds: [],
        sourceType: 'FOLLOW_UP',
        title: `Attributed reply: ${answer.actor.displayName}`,
        owner: answer.actor,
        content: answer.text,
        visibility: 'WORKSPACE',
        synthetic: meeting.synthetic,
        updatedAt: answer.receivedAt,
        availableAt: answer.receivedAt,
        url: `drii://${workspace}/${current.projectId}/${answer.sourceId}`,
        metrics: [],
      };
      await this.sources.ingestSource(source);
      const answered = await this.record(
        {
          ...current,
          revision: current.revision + 1,
          followUps: current.followUps.map((f) =>
            f.questionId === questionId
              ? { ...f, status: 'ANSWERED', answer }
              : f,
          ),
        },
        'EVIDENCE_ADDED',
        `answer:${answer.sourceId}`,
        answer.actor,
      );
      return this.resumeReview(
        answered,
        meeting,
        answer,
        `resume:${answer.sourceId}`,
      );
    });
  }
  private async resumeReview(
    current: Decision,
    meeting: Meeting,
    answer: NonNullable<FollowUp['answer']>,
    key: string,
  ): Promise<Decision> {
    if (!current.analysis?.extraction.question) {
      const extended = MeetingSchema.parse({
        ...meeting,
        revision: meeting.segments.some((s) => s.segmentId === answer.sourceId)
          ? meeting.revision
          : meeting.revision + 1,
        segments: [
          ...meeting.segments,
          ...(meeting.segments.some((s) => s.segmentId === answer.sourceId)
            ? []
            : [
                {
                  schemaVersion: SCHEMA_VERSION,
                  workspaceId: current.workspaceId,
                  meetingId: meeting.meetingId,
                  revision: meeting.revision + 1,
                  createdAt: answer.receivedAt,
                  sourceIds: [answer.sourceId],
                  segmentId: answer.sourceId,
                  speakerLabel: answer.actor.displayName,
                  speaker: answer.actor,
                  startMs: null,
                  endMs: null,
                  text: answer.text,
                },
              ]),
        ],
      });
      await this.store.ingestMeeting(extended);
      const { analysis: _previous, ...fresh } = current;
      void _previous;
      return this.review(fresh, extended, key);
    }
    return this.review(current, meeting, key);
  }
  async approveDecision(
    workspace: string,
    id: string,
    revision: number,
    actor: Actor,
    optionId: string,
  ): Promise<Decision> {
    return queue.run(workspace, id, async () => {
      const current = await this.get(workspace, id);
      this.owner(current, actor);
      if (
        current.state === 'APPROVED' &&
        current.approval?.approvedRevision === revision &&
        current.approval.optionId === optionId
      )
        return current;
      this.check(current, revision);
      if (
        current.state !== 'READY_FOR_REVIEW' ||
        !current.options.some((o) => o.optionId === optionId)
      )
        throw new WorkflowError(
          'Review must be ready and an existing option selected before approval.',
        );
      return this.record(
        {
          ...current,
          revision: revision + 1,
          state: 'APPROVED',
          approval: {
            actor,
            optionId,
            approvedRevision: revision,
            approvedAt: this.now(),
            rationale: `Owner explicitly confirmed option ${optionId} for review revision ${revision}; displayed conditions and proposed actions remain part of the record.`,
          },
        },
        'APPROVED',
        `approve:${revision}`,
        actor,
      );
    });
  }

  async correctMeeting(
    workspace: string,
    id: string,
    revision: number,
    actor: Actor,
    correction: {
      segmentId: string;
      speaker: Actor | null;
      text: string | null;
    },
  ): Promise<Decision> {
    return queue.run(workspace, id, async () => {
      const current = await this.get(workspace, id);
      this.check(current, revision);
      this.owner(current, actor);
      if (current.state === 'APPROVED')
        throw new WorkflowError(
          'Approved records are immutable. Start a new review.',
        );
      const meeting = await this.store.getMeeting(workspace, current.meetingId);
      if (
        !meeting ||
        !meeting.segments.some((s) => s.segmentId === correction.segmentId)
      )
        throw new WorkflowError('Unknown transcript segment.');
      const updated = MeetingSchema.parse({
        ...meeting,
        revision: meeting.revision + 1,
        segments: meeting.segments.map((s) =>
          s.segmentId === correction.segmentId
            ? {
                ...s,
                revision: meeting.revision + 1,
                speaker: correction.speaker ?? s.speaker,
                text: correction.text ?? s.text,
              }
            : s,
        ),
      });
      await this.store.ingestMeeting(updated);
      const { analysis: _old, ...fresh } = current;
      void _old;
      return this.review(fresh, updated, `correction:${revision}`);
    });
  }
}
