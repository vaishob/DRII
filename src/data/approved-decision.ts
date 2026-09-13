import { createHash } from 'node:crypto';
import {
  DecisionSchema,
  MeetingSchema,
  SCHEMA_VERSION,
  SourceSchema,
  type Decision,
  type Meeting,
  type Source,
} from '../contracts/index.js';
import { MAX_DOCUMENT_CHARACTERS } from './chunks.js';

const MAX_CONTEXT_TEXT = 1_200;
const MAX_CONTEXT_ITEM_TEXT = 400;
const MAX_CONTEXT_ITEMS = 8;
const shortened = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, limit)} [truncated]`;

// This is searchable organizational memory of a human choice, not a new fact
// check. The immutable decision retains the complete evidence and action plan.
export function approvedDecisionSource(
  input: Decision,
  inputMeeting: Meeting,
): Source {
  const decision = DecisionSchema.parse(input);
  const meeting = MeetingSchema.parse(inputMeeting);
  if (decision.state !== 'APPROVED' || !decision.approval)
    throw new Error(
      'Only a human-approved decision can become decision context.',
    );
  if (
    decision.workspaceId !== meeting.workspaceId ||
    decision.projectId !== meeting.projectId ||
    decision.meetingId !== meeting.meetingId
  )
    throw new Error('Decision context must match its original meeting scope.');
  const approval = decision.approval;
  const option = decision.options.find(
    (candidate) => candidate.optionId === approval.optionId,
  );
  if (!option) throw new Error('The approved option is missing.');
  const sourceId = `approved-decision-${createHash('sha256')
    .update(
      JSON.stringify([
        decision.workspaceId,
        decision.projectId,
        decision.decisionId,
      ]),
    )
    .digest('hex')
    .slice(0, 32)}`;
  const synthetic =
    meeting.synthetic ||
    decision.evidence.some((evidence) => evidence.synthetic);
  const lines = [
    `${synthetic ? 'SYNTHETIC CONTEXT INCLUDED. ' : ''}Human-approved decision record.`,
    `Decision ID: ${decision.decisionId}; saved revision: ${decision.revision}; reviewed revision: ${approval.approvedRevision}.`,
    `Title: ${shortened(decision.title, MAX_CONTEXT_TEXT)}`,
    `Approved by ${approval.actor.displayName} (${approval.actor.actorId}) at ${approval.approvedAt}.`,
    `Selected option: ${shortened(option.title, MAX_CONTEXT_TEXT)}. ${shortened(option.description, MAX_CONTEXT_TEXT)}`,
    `Meeting summary at approval: ${shortened(decision.summary, MAX_CONTEXT_TEXT)}`,
    `Approval rationale: ${shortened(approval.rationale ?? 'The owner selected this option; no separate rationale was recorded.', MAX_CONTEXT_TEXT)}`,
    'This record establishes the human choice only. It does not verify underlying claims, confirm proposed owners, or prove action completion. Consult the original dated evidence before using it to support a factual claim.',
    `AI recommendation before approval: ${decision.options.find((candidate) => candidate.optionId === decision.recommendedOptionId)?.title ?? 'none'}. The selected human option above may differ.`,
    ...(decision.analysis?.review?.recommendation.conditions ?? [])
      .slice(0, MAX_CONTEXT_ITEMS)
      .map(
        (condition) =>
          `Unverified condition of the AI recommendation: ${shortened(condition, MAX_CONTEXT_ITEM_TEXT)}`,
      ),
    'Recorded conditions and assumptions (their continued validity is unverified):',
    ...decision.assumptions
      .slice(0, MAX_CONTEXT_ITEMS)
      .map(
        (assumption) =>
          `- Assumption (continued validity unverified): ${shortened(assumption.text, MAX_CONTEXT_ITEM_TEXT)}; status at approval: ${assumption.status}.`,
      ),
    'Proposed action sequence at approval (completion is not tracked by this record):',
    ...[...decision.actions]
      .sort((a, b) => a.order - b.order)
      .slice(0, MAX_CONTEXT_ITEMS)
      .map(
        (action) =>
          `${action.order}. Proposed action, completion unverified: ${shortened(action.description, MAX_CONTEXT_ITEM_TEXT)}; proposed owner: ${action.owner?.displayName ?? 'unassigned'}; proposed due date: ${action.dueAt ?? 'not specified'}.`,
      ),
    'Original evidence references (assessment at approval only):',
    ...decision.evidence
      .slice(0, MAX_CONTEXT_ITEMS)
      .map(
        (evidence) =>
          `- ${evidence.sourceId}, source revision ${evidence.sourceRevision}, dated ${evidence.sourceDate}${evidence.synthetic ? ', synthetic' : ''}; ${shortened(evidence.sourceUrl, MAX_CONTEXT_ITEM_TEXT)}`,
      ),
    'Retrieve the saved decision in Slack with @DRII open followed by the decision ID to inspect the complete record.',
  ];
  return SourceSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    workspaceId: decision.workspaceId,
    projectId: decision.projectId,
    sourceId,
    sourceIds: [
      ...new Set(decision.evidence.map((evidence) => evidence.sourceId)),
    ],
    revision: decision.revision,
    createdAt: approval.approvedAt,
    updatedAt: approval.approvedAt,
    availableAt: approval.approvedAt,
    sourceType: 'DECISION',
    title: `${synthetic ? 'SYNTHETIC CONTEXT: ' : ''}Human-approved decision: ${shortened(decision.title, 180)}`,
    owner: approval.actor,
    content: shortened(lines.join('\n'), MAX_DOCUMENT_CHARACTERS - 20),
    visibility: 'WORKSPACE',
    synthetic,
    url: `drii://${encodeURIComponent(decision.workspaceId)}/${encodeURIComponent(decision.projectId)}/${encodeURIComponent(sourceId)}`,
    metrics: [],
  });
}
