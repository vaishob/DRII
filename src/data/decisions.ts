import { z } from 'zod';
import {
  DecisionEventSchema,
  IdSchema,
  MeetingSchema,
  type Decision,
  type DecisionEvent,
  type Meeting,
} from '../contracts/index.js';
import type { DecisionStore } from '../contracts/services.js';
import type { Database } from './database.js';
import { DecisionQueue } from './queue.js';

const PayloadRow = z.object({ payload: z.string() });
const writeQueue = new DecisionQueue();
export class PersistenceConflictError extends Error {
  constructor() {
    super(
      'An event ID, deduplication ID or revision already contains different data. Reload current state before retrying.',
    );
    this.name = 'PersistenceConflictError';
  }
}
function eventFromRow(row: unknown): DecisionEvent {
  return DecisionEventSchema.parse(JSON.parse(PayloadRow.parse(row).payload));
}
export class ClickHouseDecisionStore implements DecisionStore {
  constructor(private readonly db: Database) {}
  async ingestMeeting(input: Meeting): Promise<void> {
    const meeting = MeetingSchema.parse(input);
    await writeQueue.run(
      meeting.workspaceId,
      `meeting:${meeting.meetingId}`,
      async () => {
        const existing = await this.db.query(
          `SELECT payload FROM drii_meetings_v1
        WHERE workspace_id = {workspace:String} AND meeting_id = {meeting:String} AND revision = {revision:UInt32}`,
          {
            workspace: meeting.workspaceId,
            meeting: meeting.meetingId,
            revision: meeting.revision,
          },
        );
        for (const row of existing) {
          if (
            JSON.stringify(
              MeetingSchema.parse(JSON.parse(PayloadRow.parse(row).payload)),
            ) !== JSON.stringify(meeting)
          )
            throw new PersistenceConflictError();
        }
        if (!existing.length)
          await this.db.insert('drii_meetings_v1', [
            {
              workspace_id: meeting.workspaceId,
              meeting_id: meeting.meetingId,
              revision: meeting.revision,
              created_at_ms: Date.parse(meeting.createdAt),
              payload: JSON.stringify(meeting),
            },
          ]);
      },
    );
  }
  async getMeeting(
    workspaceId: string,
    meetingId: string,
  ): Promise<Meeting | null> {
    const rows = await this.db.query(
      `SELECT payload FROM drii_meetings_v1
      WHERE workspace_id = {workspace:String} AND meeting_id = {meeting:String}
      ORDER BY revision DESC, created_at_ms DESC, payload DESC LIMIT 1`,
      {
        workspace: IdSchema.parse(workspaceId),
        meeting: IdSchema.parse(meetingId),
      },
    );
    return rows[0]
      ? MeetingSchema.parse(JSON.parse(PayloadRow.parse(rows[0]).payload))
      : null;
  }
  async getDecision(
    workspaceId: string,
    decisionId: string,
  ): Promise<Decision | null> {
    const rows = await this.db.query(
      `SELECT payload FROM drii_decision_events_v1
      WHERE workspace_id = {workspace:String} AND decision_id = {decision:String}
      ORDER BY revision DESC, created_at_ms DESC, event_id DESC LIMIT 1`,
      {
        workspace: IdSchema.parse(workspaceId),
        decision: IdSchema.parse(decisionId),
      },
    );
    return rows[0] ? eventFromRow(rows[0]).decision : null;
  }
  async getEventByDeduplicationId(
    workspaceId: string,
    decisionId: string,
    deduplicationId: string,
  ): Promise<DecisionEvent | null> {
    const rows = await this.db.query(
      `SELECT payload FROM drii_decision_events_v1
      WHERE workspace_id = {workspace:String} AND decision_id = {decision:String} AND deduplication_id = {deduplication:String}
      ORDER BY revision DESC, event_id DESC LIMIT 1`,
      {
        workspace: IdSchema.parse(workspaceId),
        decision: IdSchema.parse(decisionId),
        deduplication: IdSchema.parse(deduplicationId),
      },
    );
    return rows[0] ? eventFromRow(rows[0]) : null;
  }
  async appendDecisionEvent(input: DecisionEvent): Promise<void> {
    const event = DecisionEventSchema.parse(input);
    await writeQueue.run(
      event.workspaceId,
      `decision:${event.decisionId}`,
      async () => {
        const existing = await this.db.query(
          `SELECT payload FROM drii_decision_events_v1
        WHERE workspace_id = {workspace:String} AND decision_id = {decision:String}
        AND (event_id = {event:String} OR deduplication_id = {deduplication:String} OR revision = {revision:UInt32})`,
          {
            workspace: event.workspaceId,
            decision: event.decisionId,
            event: event.eventId,
            deduplication: event.deduplicationId,
            revision: event.revision,
          },
        );
        for (const row of existing)
          if (JSON.stringify(eventFromRow(row)) !== JSON.stringify(event))
            throw new PersistenceConflictError();
        if (!existing.length)
          await this.db.insert('drii_decision_events_v1', [
            {
              workspace_id: event.workspaceId,
              decision_id: event.decisionId,
              meeting_id: event.meetingId,
              revision: event.revision,
              event_id: event.eventId,
              deduplication_id: event.deduplicationId,
              created_at_ms: Date.parse(event.createdAt),
              payload: JSON.stringify(event),
            },
          ]);
      },
    );
  }
}
