import type { ClickHouseClient } from "@clickhouse/client";
import { decisionEventSchema, type DecisionEvent, type DecisionEventStore } from "../contracts/index.js";

const EVENTS_TABLE = "decision_events";

interface EventRow {
  event_id: string;
  workspace_id: string;
  meeting_id: string;
  decision_id: string;
  revision: number;
  occurred_at: string;
  type: string;
  state: DecisionEvent["state"];
  actor_id: string | null;
  payload: string;
}

function toRow(event: DecisionEvent): EventRow {
  return {
    event_id: event.eventId,
    workspace_id: event.workspaceId,
    meeting_id: event.meetingId,
    decision_id: event.decisionId,
    revision: event.revision,
    occurred_at: event.occurredAt,
    type: event.type,
    state: event.state,
    actor_id: event.actorId,
    payload: JSON.stringify(event.payload),
  };
}

export class ClickHouseDecisionEventStore implements DecisionEventStore {
  public constructor(private readonly client: ClickHouseClient, private readonly database: string) {}

  public async appendDecisionEvent(event: DecisionEvent): Promise<void> {
    const validated = decisionEventSchema.parse(event);
    await this.client.insert({
      table: `${this.database}.${EVENTS_TABLE}`,
      values: [toRow(validated)],
      format: "JSONEachRow",
    });
  }

  public async getDecision(decisionId: string): Promise<DecisionEvent | null> {
    const result = await this.client.query({
      query: `SELECT event_id, workspace_id, meeting_id, decision_id, revision, occurred_at, type, state, actor_id, payload
FROM ${this.database}.${EVENTS_TABLE}
WHERE decision_id = {decisionId:String}
ORDER BY revision DESC, occurred_at DESC
LIMIT 1`,
      query_params: { decisionId },
      format: "JSONEachRow",
    });
    const row = (await result.json<EventRow[]>())[0];
    if (row === undefined) return null;
    return decisionEventSchema.parse({
      eventId: row.event_id,
      workspaceId: row.workspace_id,
      meetingId: row.meeting_id,
      decisionId: row.decision_id,
      revision: row.revision,
      occurredAt: row.occurred_at,
      type: row.type,
      state: row.state,
      actorId: row.actor_id,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
    });
  }
}
