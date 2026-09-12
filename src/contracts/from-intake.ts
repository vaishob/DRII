import { meetingSchema, type Meeting as IntakeMeeting } from './intake.js';
import {
  MeetingSchema,
  SCHEMA_VERSION,
  type Actor,
  type Meeting,
} from './index.js';

export interface MeetingContext {
  projectId: string;
  title: string;
  owner: Actor;
  createdAt: string;
  synthetic: boolean;
  transport: Meeting['transport'];
  // Explicitly supplied identity mapping, never inferred from speaker labels.
  speakers?: Record<string, Actor>;
}

/** Normalize Tolga's transport payload to the shared durable contract. */
export function fromIntakeMeeting(
  input: IntakeMeeting,
  context: MeetingContext,
): Meeting {
  const meeting = meetingSchema.parse(input);
  const record = {
    schemaVersion: SCHEMA_VERSION,
    workspaceId: meeting.workspaceId,
    meetingId: meeting.meetingId,
    revision: 0,
    createdAt: context.createdAt,
    sourceIds: [meeting.source.referenceId],
  };
  return MeetingSchema.parse({
    ...record,
    projectId: context.projectId,
    title: context.title,
    owner: context.owner,
    synthetic: context.synthetic,
    transport: context.transport,
    inputType: meeting.source.kind === 'audio' ? 'AUDIO' : 'TRANSCRIPT',
    segments: meeting.segments.map((segment) => ({
      ...record,
      segmentId: segment.id,
      text: segment.text,
      speakerLabel: segment.speakerLabel,
      speaker: segment.speakerIdentity
        ? (context.speakers?.[segment.speakerIdentity] ?? null)
        : null,
      startMs:
        segment.startSeconds === null
          ? null
          : Math.round(segment.startSeconds * 1000),
      endMs:
        segment.endSeconds === null
          ? null
          : Math.round(segment.endSeconds * 1000),
    })),
  });
}
