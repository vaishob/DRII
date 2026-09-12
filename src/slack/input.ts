import {
  MAX_AUDIO_BYTES,
  MAX_SEGMENTS,
  MAX_TRANSCRIPT_CHARS,
} from "../config/limits.js";
import type {
  Meeting,
  Transcriber,
  TranscriptSegment,
} from "../contracts/intake.js";
import { IntakeError } from "./errors.js";
import type { SlackPort } from "./ports.js";

export interface Mention {
  workspaceId: string;
  channelId: string;
  userId: string;
  ts: string;
  threadTs?: string;
  text: string;
  botId?: string;
}

export function parseCommand(text: string, botUserId: string): string | null {
  const mention = `<@${botUserId}>`;
  const trimmed = text.trim();
  if (!trimmed.startsWith(mention)) return null;
  const rest = trimmed.slice(mention.length).trim();
  const command = /^analyze(?: this meeting)?(?=$|[\s:])/i.exec(rest);
  return command
    ? rest
        .slice(command[0].length)
        .replace(/^\s*:\s*/, "")
        .trim()
    : null;
}

export function textSegments(text: string): TranscriptSegment[] {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_TRANSCRIPT_CHARS) {
    throw new IntakeError(
      "INVALID_TRANSCRIPT",
      `Paste a non-empty transcript of at most ${MAX_TRANSCRIPT_CHARS} characters.`,
    );
  }
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > MAX_SEGMENTS)
    throw new IntakeError(
      "TOO_MANY_SEGMENTS",
      "The transcript has too many lines. Please submit a shorter excerpt.",
    );
  return lines.map((line, index) => {
    const labeled = /^([^:]+):\s*(.+)$/.exec(line);
    return {
      id: `segment-${index}`,
      text: labeled?.[2] ?? line,
      speakerLabel: labeled?.[1]?.trim() ?? null,
      speakerIdentity: null,
      startSeconds: null,
      endSeconds: null,
    };
  });
}

export interface InputDependencies {
  slack: SlackPort;
  transcriber: Transcriber;
  download: (url: string, maxBytes: number) => Promise<Uint8Array>;
}

export async function resolveInput(
  mention: Mention,
  inlineText: string,
  dependencies: InputDependencies,
  onTranscribing: () => Promise<void>,
): Promise<Pick<Meeting, "source" | "segments">> {
  if (inlineText)
    return {
      source: { kind: "transcript", referenceId: mention.ts },
      segments: textSegments(inlineText),
    };
  const sourceTs = mention.threadTs ?? mention.ts;
  const source = await dependencies.slack.getMessage(
    mention.channelId,
    sourceTs,
  );
  if (source.ts !== sourceTs)
    throw new IntakeError(
      "SOURCE_NOT_FOUND",
      "The original meeting message is unavailable. Upload the recording again or paste a transcript.",
    );
  if (source.fileIds.length === 0) {
    if (sourceTs !== mention.ts && source.text.trim())
      return {
        source: { kind: "transcript", referenceId: sourceTs },
        segments: textSegments(source.text),
      };
    throw new IntakeError(
      "MISSING_INPUT",
      "Upload one MP3 or UTF-8 .txt file, then reply with @DRII analyze this meeting. You can also paste text after @DRII analyze.",
    );
  }
  if (source.fileIds.length !== 1)
    throw new IntakeError(
      "AMBIGUOUS_FILES",
      "Please put just one MP3 or .txt transcript in the source message.",
    );
  const fileId = source.fileIds[0];
  if (!fileId)
    throw new IntakeError("MISSING_FILE", "The attachment is unavailable.");
  const file = await dependencies.slack.getFile(fileId);
  const isAudio =
    file.name.toLowerCase().endsWith(".mp3") &&
    ["audio/mpeg", "audio/mp3", "application/octet-stream"].includes(
      file.mimetype,
    );
  const isText =
    file.name.toLowerCase().endsWith(".txt") &&
    ["text/plain", "application/octet-stream"].includes(file.mimetype);
  if (!isAudio && !isText)
    throw new IntakeError(
      "UNSUPPORTED_FILE",
      "This first version accepts MP3 audio or UTF-8 .txt transcripts. Please convert the recording or paste the transcript.",
    );
  const maxBytes = isAudio ? MAX_AUDIO_BYTES : MAX_TRANSCRIPT_CHARS;
  if (file.size > maxBytes)
    throw new IntakeError(
      "FILE_TOO_LARGE",
      "The file is too large. Audio is limited to 20 MB; use a short recording or paste a transcript.",
    );
  const bytes = await dependencies.download(file.downloadUrl, maxBytes);
  if (isAudio) {
    await onTranscribing();
    return {
      source: { kind: "audio", referenceId: file.id },
      segments: await dependencies.transcriber.transcribeMeeting(
        bytes,
        file.name,
      ),
    };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return {
      source: { kind: "transcript", referenceId: file.id },
      segments: textSegments(text),
    };
  } catch (error) {
    if (error instanceof IntakeError) throw error;
    throw new IntakeError(
      "INVALID_TEXT_FILE",
      "The transcript must be UTF-8 text. You can paste it directly after @DRII analyze.",
    );
  }
}
