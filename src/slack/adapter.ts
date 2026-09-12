import type { WebClient } from "@slack/web-api";
import { z } from "zod";
import { IntakeError } from "./errors.js";
import type { SlackPort } from "./ports.js";

const messageSchema = z.object({
  ts: z.string(),
  text: z.string().default(""),
  files: z.array(z.object({ id: z.string() })).default([]),
});
const fileSchema = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number().nonnegative(),
  mimetype: z.string(),
  url_private_download: z.string().optional(),
  url_private: z.string().optional(),
});

export function createSlackPort(client: WebClient): SlackPort {
  return {
    async getMessage(channel, ts) {
      const response = await client.conversations.history({
        channel,
        latest: ts,
        inclusive: true,
        limit: 1,
      });
      const message = messageSchema.safeParse(response.messages?.[0]);
      if (!message.success || message.data.ts !== ts)
        throw new IntakeError(
          "SOURCE_NOT_FOUND",
          "The original message is unavailable. Re-upload the recording or paste a transcript.",
        );
      return {
        ts: message.data.ts,
        text: message.data.text,
        fileIds: message.data.files.map((file) => file.id),
      };
    },
    async getFile(file) {
      const response = await client.files.info({ file });
      const parsed = fileSchema.safeParse(response.file);
      if (!parsed.success)
        throw new IntakeError(
          "FILE_UNAVAILABLE",
          "The attachment is not accessible to DRII. Share it in the demo channel and retry.",
        );
      const data = parsed.data;
      const downloadUrl = data.url_private_download ?? data.url_private;
      if (!downloadUrl)
        throw new IntakeError(
          "FILE_UNAVAILABLE",
          "The attachment has no downloadable content.",
        );
      return {
        id: data.id,
        name: data.name,
        size: data.size,
        mimetype: data.mimetype,
        downloadUrl,
      };
    },
    async post(channel, thread_ts, text, blocks) {
      const response = await client.chat.postMessage({
        channel,
        thread_ts,
        text,
        ...(blocks ? { blocks } : {}),
        unfurl_links: false,
        unfurl_media: false,
      });
      if (!response.ts)
        throw new IntakeError(
          "POST_FAILED",
          "DRII could not create a status message.",
        );
      return response.ts;
    },
    async update(channel, ts, text, blocks) {
      await client.chat.update({ channel, ts, text, blocks: blocks ?? [] });
    },
    async ephemeral(channel, user, thread_ts, text, blocks) {
      await client.chat.postEphemeral({
        channel,
        user,
        thread_ts,
        text,
        ...(blocks ? { blocks } : {}),
      });
    },
  };
}
