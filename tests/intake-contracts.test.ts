import { describe, expect, it } from 'vitest';
import {
  fromIntakeMeeting,
  type MeetingContext,
} from '../src/contracts/from-intake.js';
import type { Meeting } from '../src/contracts/intake.js';

const input: Meeting = {
  schemaVersion: 1,
  workspaceId: 'TDEMO',
  meetingId: 'meeting-1',
  submittedBy: 'USUBMITTER',
  source: { kind: 'transcript', referenceId: 'slack-message' },
  segments: [
    {
      id: 'segment-1',
      text: 'Review the launch evidence.',
      speakerLabel: null,
      speakerIdentity: null,
      startSeconds: null,
      endSeconds: null,
    },
  ],
};
const context: MeetingContext = {
  projectId: 'launch',
  title: 'Launch review',
  owner: { actorId: 'UOWNER', displayName: 'Owner', role: 'Product' },
  createdAt: '2026-09-12T08:00:00.000Z',
  synthetic: true,
  transport: { channelId: 'CDEMO', threadTs: '1789200000.000001' },
};

describe('Slack intake to durable meeting contract', () => {
  it('preserves unknown timing/identity and the explicitly selected owner and source', () => {
    const shared = fromIntakeMeeting(input, context);
    expect(shared.segments[0]).toMatchObject({
      startMs: null,
      endMs: null,
      speakerLabel: null,
      speaker: null,
      sourceIds: ['slack-message'],
    });
    expect(shared.owner.actorId).toBe('UOWNER');
    expect(shared.transport?.threadTs).toBe(context.transport?.threadTs);
  });
  it('converts known seconds to milliseconds without treating diarization as identity', () => {
    const audio: Meeting = {
      ...input,
      source: { kind: 'audio', referenceId: 'FMP3' },
      segments: [
        {
          ...input.segments[0]!,
          speakerLabel: 'Speaker 1',
          startSeconds: 1.25,
          endSeconds: 3.5,
        },
      ],
    };
    expect(fromIntakeMeeting(audio, context).segments[0]).toMatchObject({
      startMs: 1250,
      endMs: 3500,
      speaker: null,
      speakerLabel: 'Speaker 1',
    });
    expect(fromIntakeMeeting(audio, context).inputType).toBe('AUDIO');
  });
  it('uses only an explicit supplied identity mapping', () => {
    const attributed: Meeting = {
      ...input,
      segments: [{ ...input.segments[0]!, speakerIdentity: 'UOWNER' }],
    };
    expect(
      fromIntakeMeeting(attributed, context).segments[0]?.speaker,
    ).toBeNull();
    expect(
      fromIntakeMeeting(attributed, {
        ...context,
        speakers: { UOWNER: context.owner },
      }).segments[0]?.speaker,
    ).toEqual(context.owner);
  });
});
