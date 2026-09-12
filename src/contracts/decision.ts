import { z } from "zod";

export const decisionStateSchema = z.enum([
  "RECEIVED",
  "ANALYZING",
  "NEEDS_INPUT",
  "READY_FOR_REVIEW",
  "APPROVED",
  "FAILED",
]);
export type DecisionState = z.infer<typeof decisionStateSchema>;

export const decisionScopeSchema = z.object({
  workspaceId: z.string().min(1),
  meetingId: z.string().min(1),
  decisionId: z.string().min(1),
  revision: z.number().int().nonnegative(),
});
export type DecisionScope = z.infer<typeof decisionScopeSchema>;

export const decisionEventSchema = decisionScopeSchema.extend({
  eventId: z.string().min(1),
  occurredAt: z.string().datetime(),
  type: z.string().min(1),
  state: decisionStateSchema,
  actorId: z.string().min(1).nullable(),
  payload: z.record(z.unknown()),
});
export type DecisionEvent = z.infer<typeof decisionEventSchema>;

export interface DecisionEventStore {
  appendDecisionEvent(event: DecisionEvent): Promise<void>;
  getDecision(decisionId: string): Promise<DecisionEvent | null>;
}
