import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  MeetingSchema,
  type Actor,
  type Decision,
} from '../contracts/index.js';
import type { Records } from '../data/records.js';
import { DecisionQueue } from '../data/queue.js';
import {
  DurableDecisionWorkflow,
  stableId,
  WorkflowError,
} from '../intelligence/workflow.js';

export const ROOM_REVIEW_INTERVAL_MS = 30_000;
export const ROOM_MAX_SEGMENTS = 80;
export const ROOM_MAX_TEXT = 60_000;
const Segment = z
  .object({
    id: z.string().min(1).max(100),
    text: z.string().trim().min(1).max(6000),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    finalized: z.literal(true),
  })
  .refine((s) => s.endMs > s.startMs);
export const RoomSchema = z.object({
  id: z.string(),
  active: z.boolean(),
  muted: z.boolean(),
  createdAt: z.string(),
  segments: z.array(Segment).max(ROOM_MAX_SEGMENTS),
  lastReviewedCount: z.number(),
  lastReviewAt: z.number(),
  decisionId: z.string().nullable(),
  dismissed: z.array(z.string()),
  lastSignature: z.string(),
});
export class RoomSessions {
  private readonly queue = new DecisionQueue();
  constructor(
    private readonly records: Records,
    private readonly workflow: DurableDecisionWorkflow,
    private readonly workspace: string,
    private readonly project: string,
    private readonly owner: Actor,
    private readonly now: () => number = Date.now,
  ) {}
  async create() {
    const room = RoomSchema.parse({
      id: randomUUID(),
      active: true,
      muted: false,
      createdAt: new Date(this.now()).toISOString(),
      segments: [],
      lastReviewedCount: 0,
      lastReviewAt: 0,
      decisionId: null,
      dismissed: [],
      lastSignature: '',
    });
    await this.records.put(this.workspace, 'room', room.id, room);
    return room;
  }
  async get(id: string) {
    const r = await this.records.get(this.workspace, 'room', id, RoomSchema);
    if (!r) throw new WorkflowError('Room session unavailable.');
    return r;
  }
  async append(id: string, input: unknown) {
    return this.queue.run(this.workspace, id, async () => {
      const r = await this.get(id);
      const s = Segment.parse(input);
      if (!r.active) throw new WorkflowError('Capture is stopped.');
      const duplicate = r.segments.find((x) => x.id === s.id);
      if (duplicate) {
        if (JSON.stringify(duplicate) !== JSON.stringify(s))
          throw new WorkflowError(
            'Segment ID already contains different text.',
          );
        return r;
      }
      if (r.segments.some((x) => x.text === s.text && x.startMs === s.startMs))
        return r;
      if (
        r.segments.length >= ROOM_MAX_SEGMENTS ||
        r.segments.reduce((n, x) => n + x.text.length, 0) + s.text.length >
          ROOM_MAX_TEXT
      )
        throw new WorkflowError(
          'Room context is full. Stop capture and start another review.',
        );
      r.segments.push(s);
      await this.records.put(this.workspace, 'room', id, r);
      return r;
    });
  }
  async control(id: string, action: 'stop' | 'mute' | 'dismiss') {
    return this.queue.run(this.workspace, id, async () => {
      const r = await this.get(id);
      if (action === 'stop') r.active = false;
      if (action === 'mute') r.muted = !r.muted;
      if (action === 'dismiss' && r.lastSignature)
        r.dismissed = [...new Set([...r.dismissed, r.lastSignature])].slice(
          -20,
        );
      await this.records.put(this.workspace, 'room', id, r);
      return r;
    });
  }
  async review(id: string): Promise<{
    room: z.infer<typeof RoomSchema>;
    decision: Decision | null;
    elapsedMs: number;
    suppressed: boolean;
    retryAfterMs: number;
  }> {
    return this.queue.run(this.workspace, id, async () => {
      const r = await this.get(id);
      const started = this.now();
      if (!r.segments.length)
        throw new WorkflowError(
          'Capture or paste a finalized transcript first.',
        );
      if (r.lastReviewedCount === r.segments.length)
        return {
          room: r,
          decision: r.decisionId
            ? await this.workflow.get(this.workspace, r.decisionId)
            : null,
          elapsedMs: 0,
          suppressed: true,
          retryAfterMs: 0,
        };
      if (r.lastReviewAt && started - r.lastReviewAt < ROOM_REVIEW_INTERVAL_MS)
        return {
          room: r,
          decision: null,
          elapsedMs: 0,
          suppressed: true,
          retryAfterMs: ROOM_REVIEW_INTERVAL_MS - (started - r.lastReviewAt),
        };
      const meetingId = stableId(r.id, String(r.segments.length));
      const fields = {
        schemaVersion: '1.0',
        workspaceId: this.workspace,
        meetingId,
        revision: 0,
        createdAt: r.createdAt,
        sourceIds: [r.id],
      };
      const meeting = MeetingSchema.parse({
        ...fields,
        projectId: this.project,
        title: 'Activated room review',
        owner: this.owner,
        inputType: 'TRANSCRIPT',
        synthetic: false,
        transport: null,
        segments: r.segments.map((s) => ({
          ...fields,
          segmentId: s.id,
          speakerLabel: null,
          speaker: null,
          startMs: s.startMs,
          endMs: s.endMs,
          text: s.text,
        })),
      });
      const decision = await this.workflow.ingestMeeting(meeting);
      const signature = stableId(
        JSON.stringify(
          decision.claims
            .map((c) => [
              c.status,
              c.evidenceIds
                .map((id) => {
                  const e = decision.evidence.find((x) => x.evidenceId === id);
                  return e ? `${e.sourceId}:${e.sourceRevision}` : 'unknown';
                })
                .sort(),
            ])
            .sort(),
        ),
        decision.options
          .find((o) => o.optionId === decision.recommendedOptionId)
          ?.title.toLowerCase() ?? 'none',
      );
      const suppressed =
        r.muted ||
        r.dismissed.includes(signature) ||
        r.lastSignature === signature ||
        !decision.options.length;
      if (decision.state !== 'FAILED') r.lastReviewedCount = r.segments.length;
      r.lastReviewAt = started;
      r.decisionId = decision.decisionId;
      r.lastSignature = signature;
      await this.records.put(this.workspace, 'room', id, r);
      return {
        room: r,
        decision,
        elapsedMs: this.now() - started,
        suppressed,
        retryAfterMs: 0,
      };
    });
  }
}
