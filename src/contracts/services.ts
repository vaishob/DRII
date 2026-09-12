import type {
  Actor,
  Decision,
  DecisionEvent,
  EvidenceScope,
  FollowUp,
  Meeting,
  RetrievalResult,
  Source,
} from './index.js';

export interface DecisionStore {
  ingestMeeting(meeting: Meeting): Promise<void>;
  getMeeting(workspaceId: string, meetingId: string): Promise<Meeting | null>;
  getDecision(
    workspaceId: string,
    decisionId: string,
  ): Promise<Decision | null>;
  appendDecisionEvent(event: DecisionEvent): Promise<void>;
  getEventByDeduplicationId(
    workspaceId: string,
    decisionId: string,
    deduplicationId: string,
  ): Promise<DecisionEvent | null>;
}
export interface EvidenceRetriever {
  retrieveEvidence(
    query: string,
    scope: EvidenceScope,
  ): Promise<RetrievalResult>;
}
export interface SourceStore {
  ingestSource(source: Source): Promise<void>;
  getSource(
    workspaceId: string,
    projectId: string,
    sourceId: string,
    asOf: string,
  ): Promise<Source | null>;
}
// Alan implements these boundaries; Slack code passes normalized objects only.
// Every mutation is serialized by workspace + decision in a single process.
export interface DecisionWorkflow {
  ingestMeeting(meeting: Meeting): Promise<Decision>;
  analyzeDecision(meeting: Meeting): Promise<Decision>;
  challengeDecision(
    workspaceId: string,
    decisionId: string,
    expectedRevision: number,
  ): Promise<Decision>;
  resumeWithEvidence(
    workspaceId: string,
    decisionId: string,
    questionId: string,
    answer: NonNullable<FollowUp['answer']>,
  ): Promise<Decision>;
  approveDecision(
    workspaceId: string,
    decisionId: string,
    expectedRevision: number,
    actor: Actor,
    optionId: string,
  ): Promise<Decision>;
}
