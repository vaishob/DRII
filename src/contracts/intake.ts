import { z } from "zod";
import {
  MAX_FIELD_CHARS,
  MAX_FINDINGS,
  MAX_OPTIONS,
  MAX_SEGMENTS,
  MAX_SOURCES,
  MAX_TRANSCRIPT_CHARS,
} from "../config/limits.js";

const id = z.string().min(1);
const text = z.string().min(1).max(MAX_FIELD_CHARS);
export const segmentSchema = z
  .object({
    id,
    text: z.string().trim().min(1).max(MAX_TRANSCRIPT_CHARS),
    speakerLabel: z.string().nullable(),
    speakerIdentity: z.string().nullable(),
    startSeconds: z.number().nonnegative().nullable(),
    endSeconds: z.number().nonnegative().nullable(),
  })
  .refine(
    (s) =>
      s.startSeconds === null ||
      s.endSeconds === null ||
      s.endSeconds >= s.startSeconds,
    "Invalid segment timestamps",
  );

export const meetingSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: id,
    meetingId: id,
    submittedBy: id,
    source: z.object({
      kind: z.enum(["transcript", "audio"]),
      referenceId: id,
    }),
    segments: z.array(segmentSchema).min(1).max(MAX_SEGMENTS),
  })
  .refine(
    (m) =>
      m.segments.reduce((sum, segment) => sum + segment.text.length, 0) <=
      MAX_TRANSCRIPT_CHARS,
    "Transcript too long",
  );

export const decisionViewSchema = z.object({
  decisionId: id,
  revision: z.number().int().positive(),
  mode: z.enum(["fixture", "live"]),
  question: text,
  options: z.array(text).max(MAX_OPTIONS),
  findings: z
    .array(
      z.object({
        claim: text,
        status: z.enum(["SUPPORTED", "CONTRADICTED", "INSUFFICIENT_EVIDENCE"]),
        explanation: text,
        sourceIds: z.array(id).max(MAX_SOURCES),
      }),
    )
    .max(MAX_FINDINGS),
  sources: z
    .array(z.object({ id, title: text, excerpt: text, synthetic: z.boolean() }))
    .max(MAX_SOURCES),
});

export type TranscriptSegment = z.infer<typeof segmentSchema>;
export type Meeting = z.infer<typeof meetingSchema>;
export type DecisionView = z.infer<typeof decisionViewSchema>;

export interface DecisionAnalyzer {
  readonly mode: DecisionView["mode"];
  analyzeDecision(meeting: Meeting, signal: AbortSignal): Promise<DecisionView>;
}

export interface Transcriber {
  transcribeMeeting(
    bytes: Uint8Array,
    name: string,
  ): Promise<TranscriptSegment[]>;
}
