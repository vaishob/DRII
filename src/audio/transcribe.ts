import { toFile, type OpenAI } from "openai";
import { z } from "zod";
import {
  MAX_SEGMENTS,
  MAX_TRANSCRIPT_CHARS,
  SDK_RETRIES,
  TRANSCRIPTION_MODEL,
  TRANSCRIPTION_TIMEOUT_MS,
} from "../config/limits.js";
import type { Transcriber } from "../contracts/intake.js";
import { IntakeError } from "../slack/errors.js";

const diarizedSchema = z.object({
  segments: z
    .array(
      z
        .object({
          text: z.string().trim().min(1).max(MAX_TRANSCRIPT_CHARS),
          speaker: z.string().nullable().optional(),
          start: z.number().nonnegative(),
          end: z.number().nonnegative(),
        })
        .refine((s) => s.end >= s.start),
    )
    .min(1)
    .max(MAX_SEGMENTS),
});

export function createTranscriber(client?: Pick<OpenAI, "audio">): Transcriber {
  return {
    async transcribeMeeting(bytes, name) {
      if (!client)
        throw new IntakeError(
          "TRANSCRIPTION_NOT_CONFIGURED",
          "Audio transcription is not configured yet. Paste a transcript after @DRII analyze instead.",
        );
      try {
        const result = await client.audio.transcriptions.create(
          {
            file: await toFile(bytes, name, { type: "audio/mpeg" }),
            model: TRANSCRIPTION_MODEL,
            response_format: "diarized_json",
            chunking_strategy: "auto",
          },
          { timeout: TRANSCRIPTION_TIMEOUT_MS, maxRetries: SDK_RETRIES },
        );
        return diarizedSchema.parse(result).segments.map((segment, index) => ({
          id: `segment-${index}`,
          text: segment.text,
          speakerLabel: segment.speaker ?? null,
          speakerIdentity: null,
          startSeconds: segment.start,
          endSeconds: segment.end,
        }));
      } catch {
        throw new IntakeError(
          "TRANSCRIPTION_FAILED",
          "Transcription failed or returned unusable segments. Please retry with a new mention, or paste the prepared transcript.",
        );
      }
    },
  };
}
