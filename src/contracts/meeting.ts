import { z } from "zod";

export const transcriptSegmentSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    speakerId: z.string().min(1).nullable(),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
  })
  .refine(({ startMs, endMs }) => endMs >= startMs, {
    message: "endMs must not be earlier than startMs",
    path: ["endMs"],
  });
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

export const meetingSchema = z.object({
  workspaceId: z.string().min(1),
  meetingId: z.string().min(1),
  channelId: z.string().min(1).nullable(),
  threadTs: z.string().min(1).nullable(),
  segments: z.array(transcriptSegmentSchema).min(1),
});
export type Meeting = z.infer<typeof meetingSchema>;

export interface MeetingTranscriber {
  transcribeMeeting(audio: Uint8Array): Promise<TranscriptSegment[]>;
}
