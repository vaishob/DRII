import { describe, expect, it } from "vitest";
import { decisionEventSchema } from "../src/contracts/index.js";

describe("decision event contract", () => {
  it("requires stable scope and event identifiers", () => {
    const event = decisionEventSchema.parse({
      eventId: "event-1",
      workspaceId: "workspace-1",
      meetingId: "meeting-1",
      decisionId: "decision-1",
      revision: 0,
      occurredAt: "2026-09-12T00:00:00.000Z",
      type: "DECISION_RECEIVED",
      state: "RECEIVED",
      actorId: null,
      payload: {},
    });

    expect(event.decisionId).toBe("decision-1");
  });

  it("rejects an unsupported decision state", () => {
    expect(() =>
      decisionEventSchema.parse({
        eventId: "event-1",
        workspaceId: "workspace-1",
        meetingId: "meeting-1",
        decisionId: "decision-1",
        revision: 0,
        occurredAt: "2026-09-12T00:00:00.000Z",
        type: "DECISION_RECEIVED",
        state: "UNKNOWN",
        actorId: null,
        payload: {},
      }),
    ).toThrow();
  });
});
