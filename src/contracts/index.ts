import { z } from 'zod';

export const SCHEMA_VERSION = '1.0' as const;
export const EMBEDDING_DIMENSIONS = 1536;
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
export const MAX_EVIDENCE_RESULTS = 8;
export const IdSchema = z.string().min(1).max(256);
export const TimestampSchema = z.iso.datetime({ offset: true });
export const DecisionStateSchema = z.enum([
  'RECEIVED',
  'ANALYZING',
  'NEEDS_INPUT',
  'READY_FOR_REVIEW',
  'APPROVED',
  'FAILED',
]);
export type DecisionState = z.infer<typeof DecisionStateSchema>;
export const ActorSchema = z
  .object({
    actorId: IdSchema,
    displayName: z.string().min(1),
    role: z.string().min(1),
  })
  .strict();
export type Actor = z.infer<typeof ActorSchema>;
const RecordFields = {
  schemaVersion: z.literal(SCHEMA_VERSION),
  workspaceId: IdSchema,
  revision: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  sourceIds: z.array(IdSchema),
};
const DecisionRecordFields = { ...RecordFields, decisionId: IdSchema };

export const TranscriptSegmentSchema = z
  .object({
    ...RecordFields,
    meetingId: IdSchema,
    segmentId: IdSchema,
    speakerLabel: z.string().min(1),
    speaker: ActorSchema.nullable(),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    text: z.string().min(1),
  })
  .strict()
  .refine((s) => s.endMs > s.startMs, 'Segment end must follow start');
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const MeetingSchema = z
  .object({
    ...RecordFields,
    meetingId: IdSchema,
    projectId: IdSchema,
    title: z.string().min(1),
    owner: ActorSchema,
    inputType: z.enum(['AUDIO', 'TRANSCRIPT']),
    synthetic: z.boolean(),
    transport: z
      .object({ channelId: IdSchema, threadTs: z.string().regex(/^\d+\.\d+$/) })
      .strict()
      .nullable(),
    segments: z.array(TranscriptSegmentSchema).min(1),
  })
  .strict()
  .superRefine((m, ctx) => {
    const ids = new Set<string>();
    m.segments.forEach((s, i) => {
      if (
        s.meetingId !== m.meetingId ||
        s.workspaceId !== m.workspaceId ||
        ids.has(s.segmentId)
      )
        ctx.addIssue({
          code: 'custom',
          path: ['segments', i],
          message: 'Segment scope/ID must belong uniquely to this meeting',
        });
      ids.add(s.segmentId);
    });
  });
export type Meeting = z.infer<typeof MeetingSchema>;

export const OptionSchema = z
  .object({
    ...DecisionRecordFields,
    optionId: IdSchema,
    title: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();
export type Option = z.infer<typeof OptionSchema>;

export const ClaimSchema = z
  .object({
    ...DecisionRecordFields,
    claimId: IdSchema,
    text: z.string().min(1),
    speaker: ActorSchema.nullable(),
    status: z.enum(['SUPPORTED', 'CONTRADICTED', 'INSUFFICIENT_EVIDENCE']),
    evidenceIds: z.array(IdSchema),
    explanation: z.string(),
  })
  .strict();
export type Claim = z.infer<typeof ClaimSchema>;

export const MetricSchema = z
  .object({
    name: IdSchema,
    value: z.number().finite(),
    unit: z.string().min(1),
    measuredAt: TimestampSchema,
  })
  .strict();
export const SourceSchema = z
  .object({
    ...RecordFields,
    sourceId: IdSchema,
    projectId: IdSchema,
    sourceType: z.enum([
      'ENGINEERING',
      'CRM',
      'SUPPORT',
      'CHECKLIST',
      'DECISION',
      'FOLLOW_UP',
    ]),
    title: z.string().min(1),
    owner: ActorSchema,
    content: z.string().min(1),
    visibility: z.enum(['WORKSPACE', 'RESTRICTED']),
    synthetic: z.boolean(),
    updatedAt: TimestampSchema,
    availableAt: TimestampSchema,
    url: z.string().min(1),
    metrics: z.array(MetricSchema),
  })
  .strict();
export type Source = z.infer<typeof SourceSchema>;

export const EvidenceSchema = z
  .object({
    ...DecisionRecordFields,
    evidenceId: IdSchema,
    sourceId: IdSchema,
    sourceRevision: z.number().int().nonnegative(),
    chunkId: IdSchema,
    excerpt: z.string().min(1),
    sourceTitle: z.string().min(1),
    sourceType: SourceSchema.shape.sourceType,
    sourceDate: TimestampSchema,
    sourceUrl: z.string().min(1),
    owner: ActorSchema,
    synthetic: z.boolean(),
    metrics: z.array(MetricSchema),
    relevance: z
      .object({
        method: z.enum(['COSINE', 'KEYWORD']),
        score: z.number().finite(),
        model: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
export type Evidence = z.infer<typeof EvidenceSchema>;

export const FollowUpSchema = z
  .object({
    ...DecisionRecordFields,
    questionId: IdSchema,
    question: z.string().min(1),
    target: ActorSchema.nullable(),
    status: z.enum(['PROPOSED', 'CONFIRMED', 'ANSWERED']),
    answer: z
      .object({
        text: z.string().min(1),
        actor: ActorSchema,
        receivedAt: TimestampSchema,
        sourceId: IdSchema,
      })
      .strict()
      .nullable(),
  })
  .strict()
  .refine(
    (f) => (f.status === 'ANSWERED') === (f.answer !== null),
    'Only answered follow-ups carry answers',
  );
export type FollowUp = z.infer<typeof FollowUpSchema>;

export const ActionSchema = z
  .object({
    ...DecisionRecordFields,
    actionId: IdSchema,
    order: z.number().int().positive(),
    description: z.string().min(1),
    owner: ActorSchema.nullable(),
    dueAt: TimestampSchema.nullable(),
  })
  .strict();
export type Action = z.infer<typeof ActionSchema>;
export const AssumptionSchema = z
  .object({
    ...DecisionRecordFields,
    assumptionId: IdSchema,
    text: z.string().min(1),
    status: z.enum(['UNKNOWN', 'HOLDS', 'VIOLATED']),
    metric: z
      .object({
        name: IdSchema,
        operator: z.enum(['LT', 'LTE', 'EQ', 'GTE', 'GT']),
        threshold: z.number().finite(),
        unit: z.string().min(1),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type Assumption = z.infer<typeof AssumptionSchema>;

export const DecisionSchema = z
  .object({
    ...DecisionRecordFields,
    meetingId: IdSchema,
    projectId: IdSchema,
    owner: ActorSchema,
    title: z.string().min(1),
    summary: z.string(),
    state: DecisionStateSchema,
    options: z.array(OptionSchema),
    claims: z.array(ClaimSchema),
    evidence: z.array(EvidenceSchema),
    priorities: z.array(
      z
        .object({
          actor: ActorSchema,
          description: z.string().min(1),
          weight: z.number().nonnegative().nullable(),
          weightConfirmed: z.boolean(),
        })
        .strict()
        .refine(
          (p) => p.weight === null || p.weightConfirmed,
          'Weights require human confirmation',
        ),
    ),
    findings: z.array(
      z
        .object({
          findingId: IdSchema,
          kind: z.enum(['CHECK', 'OBJECTION', 'CHANGE']),
          text: z.string().min(1),
          evidenceIds: z.array(IdSchema),
        })
        .strict(),
    ),
    followUps: z.array(FollowUpSchema),
    actions: z.array(ActionSchema),
    assumptions: z.array(AssumptionSchema),
    recommendedOptionId: IdSchema.nullable(),
    approval: z
      .object({
        actor: ActorSchema,
        optionId: IdSchema,
        approvedRevision: z.number().int().nonnegative(),
        approvedAt: TimestampSchema,
      })
      .strict()
      .nullable(),
    failure: z
      .object({
        code: IdSchema,
        message: z.string().min(1),
        retryable: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((d, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    const children = [
      ...d.options,
      ...d.claims,
      ...d.evidence,
      ...d.followUps,
      ...d.actions,
      ...d.assumptions,
    ];
    if (
      children.some(
        (c) =>
          c.decisionId !== d.decisionId ||
          c.workspaceId !== d.workspaceId ||
          c.revision > d.revision,
      )
    )
      fail('Nested records must belong to this decision and revision history');
    const unique = (ids: string[]) => new Set(ids).size === ids.length;
    for (const ids of [
      d.options.map((o) => o.optionId),
      d.claims.map((c) => c.claimId),
      d.evidence.map((e) => e.evidenceId),
      d.followUps.map((f) => f.questionId),
      d.actions.map((a) => a.actionId),
      d.assumptions.map((a) => a.assumptionId),
      d.findings.map((f) => f.findingId),
    ])
      if (!unique(ids)) fail('Record IDs must be unique within a revision');
    if (!unique(d.actions.map((a) => String(a.order))))
      fail('Action order must be unique');
    const optionExists = (id: string) =>
      d.options.some((o) => o.optionId === id);
    if (d.recommendedOptionId !== null && !optionExists(d.recommendedOptionId))
      fail('Recommended option must exist');
    if ((d.state === 'APPROVED') !== (d.approval !== null))
      fail('Only approved decisions carry approval');
    if (
      d.approval &&
      (d.approval.actor.actorId !== d.owner.actorId ||
        d.approval.approvedRevision !== d.revision - 1 ||
        !optionExists(d.approval.optionId))
    )
      fail(
        'Approval must name the owner, an existing option, and the preceding reviewed revision',
      );
    if ((d.state === 'FAILED') !== (d.failure !== null))
      fail('Only failed decisions carry failure');
    const evidenceIds = new Set(d.evidence.map((e) => e.evidenceId));
    if (
      [...d.claims, ...d.findings].some((c) =>
        c.evidenceIds.some((id) => !evidenceIds.has(id)),
      )
    )
      fail('Cited evidence must exist in the decision');
  });
export type Decision = z.infer<typeof DecisionSchema>;

export const DecisionEventSchema = z
  .object({
    ...DecisionRecordFields,
    eventId: IdSchema,
    deduplicationId: IdSchema,
    meetingId: IdSchema,
    eventType: z.enum([
      'RECEIVED',
      'ANALYSIS_STARTED',
      'INPUT_REQUESTED',
      'REVIEW_READY',
      'EVIDENCE_ADDED',
      'APPROVED',
      'FAILED',
      'RETRIED',
    ]),
    actor: ActorSchema.nullable(),
    decision: DecisionSchema,
  })
  .strict()
  .refine(
    (e) =>
      e.workspaceId === e.decision.workspaceId &&
      e.decisionId === e.decision.decisionId &&
      e.meetingId === e.decision.meetingId &&
      e.revision === e.decision.revision,
    'Event envelope must match decision snapshot',
  );
export type DecisionEvent = z.infer<typeof DecisionEventSchema>;

export const EvidenceScopeSchema = z
  .object({
    workspaceId: IdSchema,
    projectId: IdSchema,
    decisionId: IdSchema,
    revision: z.number().int().nonnegative(),
    asOf: TimestampSchema,
    limit: z.number().int().min(1).max(MAX_EVIDENCE_RESULTS).default(5),
  })
  .strict();
export type EvidenceScope = z.input<typeof EvidenceScopeSchema>;
export type RetrievalResult =
  | { status: 'FOUND'; evidence: Evidence[] }
  | { status: 'EMPTY'; evidence: [] }
  | { status: 'UNAVAILABLE'; evidence: []; reason: 'SOURCE_NOT_ACCESSIBLE' }
  | {
      status: 'FAILED';
      evidence: [];
      code: 'DATABASE_ERROR' | 'EMBEDDING_ERROR';
      retryable: boolean;
    };
