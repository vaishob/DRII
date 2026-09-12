import { z } from "zod";
import {
  ACTION_SHOW_EVIDENCE,
  ACTION_SHOW_TRANSCRIPT,
  ANALYSIS_TIMEOUT_MS,
} from "../config/limits.js";
import {
  decisionViewSchema,
  meetingSchema,
  type DecisionAnalyzer,
} from "../contracts/intake.js";
import { decisionCard, evidenceCard, transcriptCard } from "./cards.js";
import { IntakeError, publicError } from "./errors.js";
import {
  parseCommand,
  resolveInput,
  type InputDependencies,
  type Mention,
} from "./input.js";
import type { SafeLogger } from "./ports.js";
import type { Run, RunStore } from "./run-store.js";

const actionSchema = z.object({
  team: z.object({ id: z.string() }),
  channel: z.object({ id: z.string() }),
  user: z.object({ id: z.string() }),
  message: z.object({ ts: z.string() }),
  actions: z
    .array(
      z.object({
        action_id: z.enum([ACTION_SHOW_EVIDENCE, ACTION_SHOW_TRANSCRIPT]),
        value: z.string().uuid(),
      }),
    )
    .length(1),
});

export interface ControllerDependencies extends InputDependencies {
  channelId: string;
  analyzer: DecisionAnalyzer;
  store: RunStore;
  logger: SafeLogger;
}

async function analyzeWithTimeout(
  analyzer: DecisionAnalyzer,
  meeting: z.infer<typeof meetingSchema>,
) {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(
        new IntakeError(
          "ANALYSIS_TIMEOUT",
          "The analysis timed out. Send a new mention to retry.",
        ),
      );
    }, ANALYSIS_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      analyzer.analyzeDecision(meeting, abort.signal),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createController(dependencies: ControllerDependencies) {
  const { slack, store, analyzer, logger, channelId } = dependencies;

  async function reportFailure(error: unknown, mention: Mention, run?: Run) {
    if (run) {
      run.status = "FAILED";
      store.save(run);
    }
    logger.error(
      {
        code: error instanceof IntakeError ? error.code : "PROCESSING_FAILED",
        runId: run?.id ?? "unclaimed",
      },
      "Meeting intake failed",
    );
    try {
      const message = publicError(error);
      if (run?.messageTs) await slack.update(channelId, run.messageTs, message);
      else
        await slack.ephemeral(
          channelId,
          mention.userId,
          mention.threadTs ?? mention.ts,
          message,
        );
    } catch {
      logger.error(
        { code: "FAILURE_NOTICE_FAILED" },
        "Could not deliver intake error status",
      );
    }
  }

  return {
    async handleMention(mention: Mention, botUserId: string): Promise<void> {
      if (
        mention.channelId !== channelId ||
        mention.botId ||
        mention.userId === botUserId
      )
        return;
      const inlineText = parseCommand(mention.text, botUserId);
      if (inlineText === null) return;
      let run: Run | undefined;
      try {
        run = store.claim(
          `${mention.workspaceId}:${mention.channelId}:${mention.ts}`,
          {
            workspaceId: mention.workspaceId,
            channelId,
            threadTs: mention.threadTs ?? mention.ts,
          },
        );
        if (!run) return;
        const current = run;
        const messageTs = await slack.post(
          channelId,
          current.threadTs,
          "DRII received your request. Loading the meeting…",
        );
        current.messageTs = messageTs;
        const input = await resolveInput(
          mention,
          inlineText,
          dependencies,
          async () => {
            current.status = "TRANSCRIBING";
            store.save(current);
            await slack.update(
              channelId,
              messageTs,
              "Transcribing audio and separating speaker labels…",
            );
          },
        );
        current.meeting = meetingSchema.parse({
          schemaVersion: 1,
          workspaceId: mention.workspaceId,
          meetingId: current.id,
          submittedBy: mention.userId,
          ...input,
        });
        current.status = "ANALYZING";
        store.save(current);
        await slack.update(
          channelId,
          current.messageTs,
          analyzer.mode === "fixture"
            ? "Transcript received. Preparing the clearly labeled UI demo card…"
            : "Transcript received. Reviewing the decision…",
        );
        const view = decisionViewSchema.parse(
          await analyzeWithTimeout(analyzer, current.meeting),
        );
        const sourceIds = new Set(view.sources.map((source) => source.id));
        if (
          view.mode !== analyzer.mode ||
          view.findings.some((finding) =>
            finding.sourceIds.some((id) => !sourceIds.has(id)),
          )
        ) {
          throw new IntakeError(
            "INVALID_ANALYSIS",
            "The analysis returned inconsistent source references. Please retry; no decision was approved.",
          );
        }
        current.result = view;
        await slack.update(
          channelId,
          current.messageTs,
          view.mode === "fixture"
            ? "DRII — UI demo result, not a real decision analysis"
            : "DRII — decision review",
          decisionCard(view, current.meeting, current.id),
        );
        current.status = "COMPLETED";
        store.save(current);
      } catch (error) {
        await reportFailure(error, mention, run);
      }
    },

    async handleAction(body: unknown): Promise<void> {
      const parsed = actionSchema.safeParse(body);
      if (!parsed.success) return;
      const data = parsed.data;
      if (data.channel.id !== channelId) return;
      const action = data.actions[0];
      if (!action) return;
      const run = store.get(action.value);
      try {
        if (
          !run ||
          run.workspaceId !== data.team.id ||
          run.channelId !== channelId ||
          run.messageTs !== data.message.ts ||
          run.status !== "COMPLETED" ||
          !run.result ||
          !run.meeting
        ) {
          await slack.ephemeral(
            channelId,
            data.user.id,
            data.message.ts,
            "This demo card is unavailable or expired. Start a new review in the meeting thread.",
          );
          return;
        }
        const blocks =
          action.action_id === ACTION_SHOW_EVIDENCE
            ? evidenceCard(run.result)
            : transcriptCard(run.meeting);
        await slack.ephemeral(
          channelId,
          data.user.id,
          run.threadTs,
          "DRII review details",
          blocks,
        );
      } catch {
        logger.error(
          { code: "DETAILS_FAILED" },
          "Could not show review details",
        );
      }
    },
  };
}
