import type { DecisionAnalyzer } from "../contracts/intake.js";

// Intentional UI fixture, not analysis of the user's transcript.
export const fixtureAnalyzer: DecisionAnalyzer = {
  mode: "fixture",
  async analyzeDecision(meeting) {
    return {
      decisionId: meeting.meetingId,
      revision: 1,
      mode: "fixture",
      question: "Sample decision: should we launch on Monday?",
      options: ["Launch Monday", "Delay the launch", "Limited beta"],
      findings: [
        {
          claim: "Sample claim: there are no launch blockers.",
          status: "CONTRADICTED",
          explanation:
            "The synthetic engineering record contains three open critical bugs.",
          sourceIds: ["demo-eng-001"],
        },
        {
          claim: "Sample claim: a delay risks $120k.",
          status: "INSUFFICIENT_EVIDENCE",
          explanation:
            "The fixture has no supporting revenue record. This is not a finding about your meeting.",
          sourceIds: [],
        },
      ],
      sources: [
        {
          id: "demo-eng-001",
          title: "Synthetic launch checklist",
          excerpt:
            "Demo record: three P0 issues remain open; rollback sign-off is pending.",
          synthetic: true,
        },
      ],
    };
  },
};
