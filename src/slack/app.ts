import { App, LogLevel } from "@slack/bolt";
import { z } from "zod";
import { downloadSlackFile } from "../audio/download.js";
import {
  ACTION_SHOW_EVIDENCE,
  ACTION_SHOW_TRANSCRIPT,
} from "../config/limits.js";
import type { Config } from "../config/index.js";
import type { DecisionAnalyzer, Transcriber } from "../contracts/intake.js";
import { createSlackPort } from "./adapter.js";
import { createController } from "./controller.js";
import type { SafeLogger } from "./ports.js";
import type { RunStore } from "./run-store.js";

const eventSchema = z.object({
  channel: z.string(),
  user: z.string(),
  ts: z.string(),
  text: z.string(),
  thread_ts: z.string().optional(),
  bot_id: z.string().optional(),
});

export function createSlackApp(
  config: Config,
  services: {
    analyzer: DecisionAnalyzer;
    transcriber: Transcriber;
    store: RunStore;
    logger: SafeLogger;
  },
) {
  const app = new App({
    token: config.SLACK_BOT_TOKEN,
    appToken: config.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: LogLevel.WARN,
  });
  const controller = createController({
    ...services,
    channelId: config.SLACK_DEMO_CHANNEL_ID,
    slack: createSlackPort(app.client),
    download: (url, maxBytes) =>
      downloadSlackFile(url, config.SLACK_BOT_TOKEN, maxBytes),
  });
  app.event("app_mention", async ({ event, context }) => {
    const parsed = eventSchema.safeParse(event);
    if (!parsed.success || !context.teamId || !context.botUserId) return;
    const data = parsed.data;
    await controller.handleMention(
      {
        workspaceId: context.teamId,
        channelId: data.channel,
        userId: data.user,
        ts: data.ts,
        text: data.text,
        ...(data.thread_ts ? { threadTs: data.thread_ts } : {}),
        ...(data.bot_id ? { botId: data.bot_id } : {}),
      },
      context.botUserId,
    );
  });
  for (const action of [ACTION_SHOW_EVIDENCE, ACTION_SHOW_TRANSCRIPT]) {
    app.action(action, async ({ ack, body }) => {
      await ack();
      await controller.handleAction(body);
    });
  }
  app.error(async () => {
    services.logger.error(
      { code: "SLACK_HANDLER_ERROR" },
      "Slack reported an application error; inspect configuration and connectivity",
    );
  });
  return app;
}
