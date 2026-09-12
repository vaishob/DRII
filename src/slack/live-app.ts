import { App, LogLevel } from "@slack/bolt";
import { z } from "zod";
import type { SlackConfig } from "../config/index.js";
import { createSlackPort } from "./adapter.js";
import { LiveController, type LiveDependencies } from "./live-controller.js";
import { LIVE_ACTIONS } from "./live-cards.js";

const Mention = z.object({
  channel: z.string(),
  user: z.string(),
  ts: z.string(),
  text: z.string(),
  thread_ts: z.string().optional(),
  bot_id: z.string().optional(),
});
export function createLiveSlackApp(
  config: SlackConfig,
  services: Omit<
    LiveDependencies,
    "slack" | "workspace" | "channel" | "project" | "owner"
  >,
) {
  const app = new App({
    token: config.SLACK_BOT_TOKEN,
    appToken: config.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: LogLevel.WARN,
  });
  const controller = new LiveController({
    ...services,
    slack: createSlackPort(app.client),
    workspace: config.DRII_DEMO_WORKSPACE_ID,
    channel: config.SLACK_DEMO_CHANNEL_ID,
    project: config.DRII_DEMO_PROJECT_ID,
    owner: {
      actorId: config.DRII_DECISION_OWNER_ID,
      displayName: config.DRII_DECISION_OWNER_ID,
      role: "Configured decision owner",
    },
  });
  app.event("app_mention", async ({ event, context }) => {
    const parsed = Mention.safeParse(event);
    if (!parsed.success || !context.teamId || !context.botUserId) return;
    const m = parsed.data;
    await controller.handleMention(
      {
        workspaceId: context.teamId,
        channelId: m.channel,
        userId: m.user,
        ts: m.ts,
        text: m.text,
        ...(m.thread_ts ? { threadTs: m.thread_ts } : {}),
        ...(m.bot_id ? { botId: m.bot_id } : {}),
      },
      context.botUserId,
    );
  });
  app.event("message", async ({ event, context }) => {
    // Ignore edits, deletions, bot output and unthreaded messages.
    if ("subtype" in event && event.subtype) return;
    const parsed = Mention.safeParse(event);
    if (
      !parsed.success ||
      !context.teamId ||
      !parsed.data.thread_ts ||
      parsed.data.bot_id ||
      parsed.data.user === context.botUserId
    )
      return;
    const m = parsed.data;
    await controller.handleReply({
      workspace: context.teamId,
      channel: m.channel,
      thread: m.thread_ts!,
      user: m.user,
      ts: m.ts,
      text: m.text,
    });
  });
  for (const name of LIVE_ACTIONS)
    app.action(`drii_live_${name}`, async ({ ack, body }) => {
      await ack();
      await controller.handleAction(body);
    });
  app.error(async () => {
    services.logger.error(
      { code: "SLACK_HANDLER_ERROR" },
      "Slack request failed; check connectivity and refresh the decision.",
    );
  });
  return app;
}
