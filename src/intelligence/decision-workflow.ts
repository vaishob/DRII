import { randomUUID } from "node:crypto";
import {
  decisionAnalysisSchema,
  type DecisionAnalysis,
  type DecisionApprover,
  type DecisionEvent,
  type DecisionEventStore,
  type DecisionAnalyzer,
  type EvidenceRetriever,
  type Meeting,
} from "../contracts/index.js";

export interface StartDecisionInput {
  decisionId: string;
  meeting: Meeting;
  projectId: string | null;
  ownerId: string;
}

export interface DecisionWorkflowResult {
  decisionId: string;
  revision: number;
  analysis: DecisionAnalysis;
  evidenceByClaim: Record<string, string[]>;
}

/**
 * Serializes decision mutations in this process and persists each observable state.
 * Database-level concurrency is deliberately handled by the persistence adapter.
 */
export class DecisionWorkflow {
  private readonly queues = new Map<string, Promise<void>>();

  public constructor(
    private readonly eventStore: DecisionEventStore,
    private readonly analyzer: DecisionAnalyzer,
    private readonly evidenceRetriever: EvidenceRetriever,
    private readonly approver: DecisionApprover,
  ) {}

  public async start(
    input: StartDecisionInput,
  ): Promise<DecisionWorkflowResult> {
    return this.runExclusive(input.decisionId, async () => {
      const existing = await this.eventStore.getDecision(input.decisionId);
      if (existing !== null) {
        throw new Error(`Decision ${input.decisionId} already exists`);
      }

      await this.append({
        decisionId: input.decisionId,
        workspaceId: input.meeting.workspaceId,
        meetingId: input.meeting.meetingId,
        revision: 0,
        type: "DECISION_RECEIVED",
        state: "RECEIVED",
        actorId: input.ownerId,
        payload: { ownerId: input.ownerId },
      });
      await this.append({
        decisionId: input.decisionId,
        workspaceId: input.meeting.workspaceId,
        meetingId: input.meeting.meetingId,
        revision: 1,
        type: "ANALYSIS_STARTED",
        state: "ANALYZING",
        actorId: null,
        payload: {},
      });

      try {
        const analysis = decisionAnalysisSchema.parse(
          await this.analyzer.analyzeDecision(input.meeting),
        );
        const evidenceByClaim = Object.fromEntries(
          await Promise.all(
            analysis.claims.map(async (claim) => {
              const evidence = await this.evidenceRetriever.retrieveEvidence(
                claim.text,
                {
                  workspaceId: input.meeting.workspaceId,
                  projectId: input.projectId,
                  visibility: "PRIVATE",
                  before: null,
                },
              );
              return [claim.id, evidence.map((item) => item.sourceId)];
            }),
          ),
        );
        const state =
          analysis.nextQuestion === null ? "READY_FOR_REVIEW" : "NEEDS_INPUT";
        const revision = 2;
        await this.append({
          decisionId: input.decisionId,
          workspaceId: input.meeting.workspaceId,
          meetingId: input.meeting.meetingId,
          revision,
          type: "ANALYSIS_COMPLETED",
          state,
          actorId: null,
          payload: { analysis, evidenceByClaim, ownerId: input.ownerId },
        });
        return {
          decisionId: input.decisionId,
          revision,
          analysis,
          evidenceByClaim,
        };
      } catch (error: unknown) {
        await this.append({
          decisionId: input.decisionId,
          workspaceId: input.meeting.workspaceId,
          meetingId: input.meeting.meetingId,
          revision: 2,
          type: "ANALYSIS_FAILED",
          state: "FAILED",
          actorId: null,
          payload: { message: errorMessage(error) },
        });
        throw error;
      }
    });
  }

  public async approve(
    decisionId: string,
    expectedRevision: number,
    actorId: string,
    optionId: string,
  ): Promise<DecisionEvent> {
    return this.runExclusive(decisionId, async () => {
      const current = await this.requireRevision(decisionId, expectedRevision);
      if (current.state !== "READY_FOR_REVIEW") {
        throw new Error(`Decision ${decisionId} is not ready for approval`);
      }
      const event = await this.approver.approveDecision(
        decisionId,
        expectedRevision,
        actorId,
        optionId,
      );
      if (
        event.revision !== expectedRevision + 1 ||
        event.state !== "APPROVED"
      ) {
        throw new Error("Approver returned an invalid approval revision");
      }
      await this.eventStore.appendDecisionEvent(event);
      return event;
    });
  }

  private async requireRevision(
    decisionId: string,
    expectedRevision: number,
  ): Promise<DecisionEvent> {
    const current = await this.eventStore.getDecision(decisionId);
    if (current === null)
      throw new Error(`Decision ${decisionId} does not exist`);
    if (current.revision !== expectedRevision) {
      throw new Error(
        `Decision ${decisionId} has revision ${current.revision}, expected ${expectedRevision}`,
      );
    }
    return current;
  }

  private async append(
    event: Omit<DecisionEvent, "eventId" | "occurredAt">,
  ): Promise<void> {
    await this.eventStore.appendDecisionEvent({
      ...event,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
    });
  }

  private async runExclusive<T>(
    decisionId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queues.get(decisionId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.queues.set(decisionId, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.queues.get(decisionId) === tail) this.queues.delete(decisionId);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown analysis failure";
}
