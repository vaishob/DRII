import { describe, expect, it, vi } from "vitest";
import type {
  DecisionAnalyzer,
  DecisionApprover,
  EvidenceRetriever,
} from "../src/contracts/index.js";
import { InMemoryDecisionEventStore } from "../src/data/in-memory-event-store.js";
import { DecisionWorkflow } from "../src/intelligence/index.js";

const meeting = {
  workspaceId: "workspace-1",
  meetingId: "meeting-1",
  channelId: "channel-1",
  threadTs: "1.0",
  segments: [
    {
      id: "segment-1",
      text: "Choose option A",
      speakerId: null,
      startMs: 0,
      endMs: 1000,
    },
  ],
};

const analyzer: DecisionAnalyzer = {
  analyzeDecision: vi.fn().mockResolvedValue({
    options: [{ id: "option-a", label: "Option A" }],
    criteria: ["cost"],
    claims: [
      {
        id: "claim-1",
        text: "Option A costs less",
        status: "INSUFFICIENT_EVIDENCE",
      },
    ],
    findings: [],
    nextQuestion: null,
  }),
  challengeDecision: vi.fn(),
  resumeWithEvidence: vi.fn(),
};

const retriever: EvidenceRetriever = {
  retrieveEvidence: vi.fn().mockResolvedValue([
    {
      sourceId: "source-1",
      title: "Budget",
      excerpt: "A is lower cost",
      occurredAt: "2026-09-01T00:00:00.000Z",
      relevance: 0.9,
      metadata: {},
    },
  ]),
};

const approver: DecisionApprover = { approveDecision: vi.fn() };

describe("DecisionWorkflow", () => {
  it("persists an analyzed decision with evidence source IDs", async () => {
    const store = new InMemoryDecisionEventStore();
    const workflow = new DecisionWorkflow(store, analyzer, retriever, approver);

    const result = await workflow.start({
      decisionId: "decision-1",
      meeting,
      projectId: null,
      ownerId: "owner-1",
    });

    expect(result).toMatchObject({
      revision: 2,
      evidenceByClaim: { "claim-1": ["source-1"] },
    });
    await expect(store.getDecision("decision-1")).resolves.toMatchObject({
      state: "READY_FOR_REVIEW",
      revision: 2,
    });
  });
});
