import { describe, expect, it } from "vitest";
import { InMemoryDecisionEventStore } from "../src/data/in-memory-event-store.js";

const baseEvent = {
  workspaceId: "workspace-1",
  meetingId: "meeting-1",
  decisionId: "decision-1",
  occurredAt: "2026-09-12T00:00:00.000Z",
  type: "DECISION_RECEIVED",
  state: "RECEIVED" as const,
  actorId: null,
  payload: {},
};

describe("InMemoryDecisionEventStore", () => {
  it("deduplicates event IDs and returns the newest revision", async () => {
    const store = new InMemoryDecisionEventStore();
    await store.appendDecisionEvent({
      ...baseEvent,
      eventId: "event-1",
      revision: 0,
    });
    await store.appendDecisionEvent({
      ...baseEvent,
      eventId: "event-1",
      revision: 3,
    });
    await store.appendDecisionEvent({
      ...baseEvent,
      eventId: "event-2",
      revision: 1,
    });

    await expect(store.getDecision("decision-1")).resolves.toMatchObject({
      eventId: "event-2",
      revision: 1,
    });
  });
});
