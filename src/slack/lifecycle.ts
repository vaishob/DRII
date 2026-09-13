import type { App } from "@slack/bolt";
import {
  LogLevel,
  type WebClientOptions,
  type WebClient,
} from "@slack/web-api";
import type { SlackConfig } from "../config/index.js";
import type { SafeLogger } from "./ports.js";

export const SLACK_REQUEST_TIMEOUT_MS = 15_000;
export function slackClientOptions(): WebClientOptions {
  return {
    timeout: SLACK_REQUEST_TIMEOUT_MS,
    // The controller owns explicit retries. A lost post acknowledgement must not cause a hidden duplicate send.
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
  };
}
export function slackSdkLogger(logger: SafeLogger) {
  return {
    debug() {},
    info() {},
    warn() {
      logger.warn(
        { code: "SLACK_SDK_WARNING" },
        "Slack reported a connectivity or request warning.",
      );
    },
    error() {
      logger.error(
        { code: "SLACK_SDK_ERROR" },
        "Slack reported a connectivity or request error.",
      );
    },
    setLevel() {},
    getLevel() {
      return LogLevel.WARN;
    },
    setName() {},
  };
}
export async function verifySlackStartup(
  client: Pick<WebClient, "auth" | "conversations">,
  config: SlackConfig,
): Promise<void> {
  try {
    const identity = await client.auth.test();
    if (
      !identity.ok ||
      !identity.bot_id ||
      !identity.user_id ||
      (config.DRII_ANALYSIS_MODE === "live" &&
        identity.team_id !== config.DRII_DEMO_WORKSPACE_ID)
    )
      throw new Error("Bot identity mismatch");
    const channel = await client.conversations.history({
      channel: config.SLACK_DEMO_CHANNEL_ID,
      limit: 1,
    });
    if (!channel.ok) throw new Error("Channel unavailable");
  } catch {
    throw new Error(
      "Slack startup checks failed. Check bot token, configured workspace/channel, channel membership and channels:history scope.",
    );
  }
}
/** Stop accepting events, disconnect, then finish acquired work before shared storage closes. */
export function withSlackLifecycle(app: App, config: SlackConfig): App {
  const active = new Set<Promise<void>>();
  let stopping = false;
  let closed: Promise<void> | undefined;
  app.use(async ({ next }) => {
    if (stopping) return;
    const work = Promise.resolve().then(next);
    active.add(work);
    try {
      await work;
    } finally {
      active.delete(work);
    }
  });
  const start = app.start.bind(app);
  const stop = app.stop.bind(app);
  app.start = async (...args) => {
    if (stopping) throw new Error("Slack app is already shutting down.");
    await verifySlackStartup(app.client, config);
    if (stopping) throw new Error("Slack app is already shutting down.");
    return start(...args);
  };
  app.stop = (...args) => {
    if (!closed) {
      stopping = true;
      closed = (async () => {
        try {
          await stop(...args);
        } finally {
          await Promise.allSettled([...active]);
        }
      })();
    }
    return closed;
  };
  return app;
}
