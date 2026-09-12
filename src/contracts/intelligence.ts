import { z } from "zod";
import type { DecisionEvent } from "./decision.js";
import type { Evidence } from "./evidence.js";
import type { Meeting } from "./meeting.js";

export const claimStatusSchema = z.enum([
  "SUPPORTED",
  "CONTRADICTED",
  "INSUFFICIENT_EVIDENCE",
]);
export const decisionAnalysisSchema = z.object({
  options: z
    .array(z.object({ id: z.string().min(1), label: z.string().min(1) }))
    .min(1),
  criteria: z.array(z.string().min(1)),
  claims: z.array(
    z.object({
      id: z.string().min(1),
      text: z.string().min(1),
      status: claimStatusSchema,
    }),
  ),
  findings: z.array(
    z.object({
      claimId: z.string().min(1),
      evidenceIds: z.array(z.string().min(1)),
    }),
  ),
  nextQuestion: z
    .object({
      id: z.string().min(1),
      text: z.string().min(1),
      targetActorId: z.string().min(1).nullable(),
    })
    .nullable(),
});
export type DecisionAnalysis = z.infer<typeof decisionAnalysisSchema>;

export interface DecisionAnalyzer {
  analyzeDecision(meeting: Meeting): Promise<DecisionAnalysis>;
  challengeDecision(
    decisionId: string,
    expectedRevision: number,
  ): Promise<DecisionEvent>;
  resumeWithEvidence(
    decisionId: string,
    questionId: string,
    answer: string,
  ): Promise<DecisionEvent>;
}

export interface DecisionApprover {
  approveDecision(
    decisionId: string,
    expectedRevision: number,
    actorId: string,
    optionId: string,
  ): Promise<DecisionEvent>;
}

export interface EvidenceAssessor {
  assess(
    claim: string,
    evidence: Evidence[],
  ): Promise<z.infer<typeof claimStatusSchema>>;
}
