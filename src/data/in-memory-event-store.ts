import {
  decisionEventSchema,
  type DecisionEvent,
  type DecisionEventStore,
} from "../contracts/index.js";

/** A deterministic adapter for contract tests and local fixture demonstrations. */
export class InMemoryDecisionEventStore implements DecisionEventStore {
  private readonly eventsById = new Map<string, DecisionEvent>();

  public async appendDecisionEvent(event: DecisionEvent): Promise<void> {
    const validated = decisionEventSchema.parse(event);
    if (!this.eventsById.has(validated.eventId)) {
      this.eventsById.set(validated.eventId, validated);
    }
  }

  public async getDecision(decisionId: string): Promise<DecisionEvent | null> {
    const matches = [...this.eventsById.values()]
      .filter((event) => event.decisionId === decisionId)
      .sort(
        (left, right) =>
          right.revision - left.revision ||
          right.occurredAt.localeCompare(left.occurredAt),
      );
    return matches[0] ?? null;
  }
}
