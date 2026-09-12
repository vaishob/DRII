import { z } from "zod";
import { fromIntakeMeeting } from "../contracts/from-intake.js";
import {
  MeetingSchema,
  type Actor,
  type Decision,
} from "../contracts/index.js";
import type { Records } from "../data/records.js";
import { DecisionQueue } from "../data/queue.js";
import {
  DurableDecisionWorkflow,
  stableId,
  WorkflowError,
} from "../intelligence/workflow.js";
import { liveCard, section } from "./live-cards.js";
import {
  parseCommand,
  resolveInput,
  type InputDependencies,
  type Mention,
} from "./input.js";
import type { Blocks, SafeLogger } from "./ports.js";

const RunSchema = z.object({
  id: z.string(),
  workspace: z.string(),
  channel: z.string(),
  thread: z.string(),
  createdAt: z.string(),
  messageTs: z.string().nullable(),
  meeting: MeetingSchema.nullable(),
  phase: z.enum(["CLAIMED", "READY", "FAILED"]),
});
type LiveRun = z.infer<typeof RunSchema>;
const Action = z.object({
  team: z.object({ id: z.string() }),
  channel: z.object({ id: z.string() }),
  user: z.object({ id: z.string().regex(/^[UW][A-Z0-9]+$/) }),
  message: z.object({ ts: z.string() }),
  actions: z
    .array(
      z.object({
        action_id: z.string(),
        action_ts: z.string().optional(),
        value: z.string().optional(),
      }),
    )
    .length(1),
  state: z
    .object({
      values: z.record(
        z.string(),
        z.record(
          z.string(),
          z.object({
            selected_user: z.string().nullish(),
            selected_option: z.object({ value: z.string() }).nullish(),
          }),
        ),
      ),
    })
    .optional(),
});
const ButtonValue = z.object({
  id: z.string(),
  revision: z.number().int().nonnegative(),
});
export interface MonitoringPort {
  review(d: Decision): Promise<string>;
  mute(d: Decision, actor: Actor, deliveryId?: string): Promise<string>;
  dismiss(d: Decision, actor: Actor): Promise<string>;
}
export interface LiveDependencies extends InputDependencies {
  workspace: string;
  channel: string;
  project: string;
  owner: Actor;
  workflow: DurableDecisionWorkflow;
  records: Records;
  logger: SafeLogger;
  monitor?: MonitoringPort;
}
export class LiveController {
  private readonly queue = new DecisionQueue();
  constructor(private readonly d: LiveDependencies) {}
  private async run(workspace: string, id: string): Promise<LiveRun> {
    const run = await this.d.records.get(workspace, "slack-run", id, RunSchema);
    if (
      !run ||
      run.channel !== this.d.channel ||
      workspace !== this.d.workspace
    )
      throw new WorkflowError("Review unavailable in this channel.");
    return run;
  }
  private async save(run: LiveRun) {
    await this.d.records.put(
      run.workspace,
      "slack-run",
      run.id,
      RunSchema.parse(run),
    );
  }
  private async display(run: LiveRun, decision: Decision) {
    if (!run.messageTs)
      throw new WorkflowError(
        "The initial Slack delivery was interrupted. Start a new review with a new mention.",
      );
    await this.d.slack.update(
      run.channel,
      run.messageTs,
      `DRII: ${decision.state}`,
      liveCard(decision),
    );
    run.phase = "READY";
    await this.save(run);
  }
  private async tell(
    user: string,
    thread: string,
    text: string,
    blocks?: Blocks,
  ) {
    await this.d.slack.ephemeral(this.d.channel, user, thread, text, blocks);
  }
  private actor(user: string): Actor {
    return user === this.d.owner.actorId
      ? this.d.owner
      : {
          actorId: user,
          displayName: user,
          role: "Participant (unconfirmed role)",
        };
  }
  private async failure(user: string, thread: string, error: unknown) {
    this.d.logger.error(
      { code: "LIVE_WORKFLOW_FAILED" },
      "Live workflow failed",
    );
    await this.tell(
      user,
      thread,
      error instanceof WorkflowError
        ? error.message
        : "The operation failed. Refresh the decision and retry. No successful approval is implied.",
    );
  }
  async handleMention(mention: Mention, botId: string) {
    if (
      mention.workspaceId !== this.d.workspace ||
      mention.channelId !== this.d.channel ||
      mention.botId ||
      mention.userId === botId
    )
      return;
    const open = new RegExp(`^<@${botId}>\\s+open\\s+([a-f0-9]{32})$`).exec(
      mention.text.trim(),
    );
    if (open) {
      try {
        const decision = await this.d.workflow.get(
          mention.workspaceId,
          open[1]!,
        );
        const existing = await this.d.records.get(
          mention.workspaceId,
          "slack-run",
          decision.decisionId,
          RunSchema,
        );
        if (existing) {
          await this.display(existing, decision);
          return;
        }
        await this.queue.run(
          mention.workspaceId,
          decision.decisionId,
          async () => {
            if (
              await this.d.records.get(
                mention.workspaceId,
                "slack-run",
                decision.decisionId,
                RunSchema,
              )
            )
              return;
            const run: LiveRun = {
              id: decision.decisionId,
              workspace: mention.workspaceId,
              channel: mention.channelId,
              thread: mention.threadTs ?? mention.ts,
              createdAt: new Date().toISOString(),
              messageTs: null,
              meeting: await this.d.workflow.store.getMeeting(
                mention.workspaceId,
                decision.meetingId,
              ),
              phase: "CLAIMED",
            };
            await this.save(run);
            run.messageTs = await this.d.slack.post(
              run.channel,
              run.thread,
              `DRII: ${decision.state}`,
              liveCard(decision),
            );
            await this.save(run);
            await this.d.records.put(
              run.workspace,
              "slack-thread",
              `${run.channel}:${run.thread}`,
              { id: run.id },
            );
          },
        );
      } catch (error) {
        await this.failure(
          mention.userId,
          mention.threadTs ?? mention.ts,
          error,
        );
      }
      return;
    }
    const special = new RegExp(
      `^<@${botId}>\\s+(resume|status|map|correct)\\s+([a-f0-9]{32})(?:\\s+([\\s\\S]+))?$`,
    ).exec(mention.text.trim());
    try {
      if (special) {
        const run = await this.run(mention.workspaceId, special[2]!);
        let decision = await this.d.workflow.store.getDecision(
          run.workspace,
          run.id,
        );
        if (!decision && run.meeting && special[1] === "resume")
          decision = await this.d.workflow.ingestMeeting(run.meeting);
        if (!decision)
          throw new WorkflowError(
            "Intake did not complete. Submit a new transcript or recording.",
          );
        if (special[1] === "resume") {
          if (["RECEIVED", "ANALYZING", "FAILED"].includes(decision.state))
            decision = await this.d.workflow.challengeDecision(
              run.workspace,
              run.id,
              decision.revision,
            );
        } else if (special[1] === "map" || special[1] === "correct") {
          const match = /^(\S+)\s+([\s\S]+)$/.exec(special[3] ?? "");
          if (!match)
            throw new WorkflowError(
              "Use map <decision-id> <segment-id> <@person>, or correct <decision-id> <segment-id> corrected text.",
            );
          const user = /^<@([UW][A-Z0-9]+)>$/.exec(match[2]!);
          if (special[1] === "map" && !user)
            throw new WorkflowError(
              "Select a real Slack person for the speaker mapping.",
            );
          decision = await this.d.workflow.correctMeeting(
            run.workspace,
            run.id,
            decision.revision,
            this.actor(mention.userId),
            {
              segmentId: match[1]!,
              speaker: user ? this.actor(user[1]!) : null,
              text: special[1] === "correct" ? match[2]!.slice(0, 6000) : null,
            },
          );
        }
        await this.display(run, decision);
        return;
      }
      const inline = parseCommand(mention.text, botId);
      if (inline === null) return;
      const id = stableId(mention.workspaceId, mention.channelId, mention.ts);
      await this.queue.run(mention.workspaceId, id, async () => {
        const previous = await this.d.records.get(
          mention.workspaceId,
          "slack-run",
          id,
          RunSchema,
        );
        if (previous) return; // Stable receipt survives service restarts; explicit resume is separate.
        const run: LiveRun = {
          id,
          workspace: mention.workspaceId,
          channel: mention.channelId,
          thread: mention.threadTs ?? mention.ts,
          createdAt: new Date().toISOString(),
          messageTs: null,
          meeting: null,
          phase: "CLAIMED",
        };
        await this.save(run);
        run.messageTs = await this.d.slack.post(
          run.channel,
          run.thread,
          `DRII queued review ${id}. Use @DRII resume ${id} after an interruption.`,
        );
        await this.save(run);
        try {
          const input = await resolveInput(
            mention,
            inline,
            this.d,
            async () => {
              await this.d.slack.update(
                run.channel,
                run.messageTs!,
                "Transcribing the recording…",
              );
            },
          );
          run.meeting = fromIntakeMeeting(
            {
              schemaVersion: 1,
              workspaceId: run.workspace,
              meetingId: id,
              submittedBy: mention.userId,
              ...input,
            },
            {
              projectId: this.d.project,
              title: "Meeting decision review",
              owner: this.d.owner,
              createdAt: run.createdAt,
              synthetic: false,
              transport: { channelId: run.channel, threadTs: run.thread },
            },
          );
          await this.save(run);
          await this.d.records.put(
            run.workspace,
            "slack-thread",
            `${run.channel}:${run.thread}`,
            { id },
          );
          await this.d.slack.update(
            run.channel,
            run.messageTs,
            "Analyzing the meeting and retrieving evidence…",
          );
          const decision = await this.d.workflow.ingestMeeting(run.meeting);
          await this.display(run, decision);
        } catch (error) {
          run.phase = "FAILED";
          await this.save(run);
          await this.d.slack.update(
            run.channel,
            run.messageTs!,
            `Review interrupted. Use @DRII resume ${id}, or submit a new transcript if intake failed.`,
          );
          throw error;
        }
      });
    } catch (error) {
      await this.failure(mention.userId, mention.threadTs ?? mention.ts, error);
    }
  }
  async handleAction(body: unknown) {
    const parsed = Action.safeParse(body);
    if (!parsed.success) return;
    const a = parsed.data;
    if (a.channel.id !== this.d.channel || a.team.id !== this.d.workspace)
      return;
    const action = a.actions[0]!;
    if (!action.value) return; // selectors carry state; only explicit buttons mutate.
    try {
      const value = ButtonValue.parse(JSON.parse(action.value));
      const run = await this.run(a.team.id, value.id);
      if (run.messageTs !== a.message.ts)
        throw new WorkflowError("This control belongs to another message.");
      let decision = await this.d.workflow.get(run.workspace, run.id);
      const name = action.action_id.replace("drii_live_", "");
      const actor = this.actor(a.user.id);
      if (name === "evidence") {
        const blocks = decision.evidence.map((e) =>
          section(
            `${e.synthetic ? "SYNTHETIC · " : ""}${e.sourceType} · ${e.sourceTitle}\n${e.excerpt}\n${e.sourceId} revision ${e.sourceRevision} · ${e.sourceDate}\n${e.sourceUrl}`,
          ),
        );
        await this.tell(
          a.user.id,
          run.thread,
          "Exact retrieved evidence",
          blocks.length
            ? blocks
            : [
                section(
                  "No retrieved evidence. Missing evidence is not proof of falsehood.",
                ),
              ],
        );
        return;
      }
      if (name === "changes") {
        const meeting = await this.d.workflow.store.getMeeting(
          run.workspace,
          run.id,
        );
        await this.tell(
          a.user.id,
          run.thread,
          `Owner: correct a transcript with @DRII correct ${run.id} <segment-id> <corrected text>, map a speaker with @DRII map ${run.id} <segment-id> <@person>, then re-review.\n${
            meeting?.segments
              .map((s) => `${s.segmentId}: ${s.text}`)
              .join("\n")
              .slice(0, 2400) ?? ""
          }`,
        );
        return;
      }
      if (name === "challenge")
        decision = await this.d.workflow.challengeDecision(
          run.workspace,
          run.id,
          value.revision,
        );
      if (name === "request") {
        const target =
          a.state?.values[`recipient_${value.revision}`]?.drii_live_recipient
            ?.selected_user;
        if (!target || !/^[UW][A-Z0-9]+$/.test(target))
          throw new WorkflowError(
            "Choose an actual recipient before sending the follow-up.",
          );
        decision = await this.d.workflow.confirmFollowUp(
          run.workspace,
          run.id,
          value.revision,
          actor,
          this.actor(target),
        );
        await this.display(run, decision);
        const question = decision.followUps.find(
          (f) => f.status === "CONFIRMED",
        )!;
        // Persist the send attempt before the external side effect. An uncertain delivery is never automatically sent twice.
        const receipt = `${run.id}:${question.questionId}`;
        if (
          !(await this.d.records.get(
            run.workspace,
            "follow-up-send",
            receipt,
            z.object({ attempted: z.boolean() }),
          ))
        ) {
          await this.d.records.put(run.workspace, "follow-up-send", receipt, {
            attempted: true,
          });
          await this.d.slack.post(
            run.channel,
            run.thread,
            `<@${target}> DRII follow-up ${question.questionId}: ${question.question}\nReply in this thread with ${question.questionId}: your answer.`,
          );
        }
        return;
      }
      if (name === "approve") {
        const option =
          a.state?.values[`option_${value.revision}`]?.drii_live_option
            ?.selected_option?.value;
        if (!option)
          throw new WorkflowError("Select the option you intend to approve.");
        decision = await this.d.workflow.approveDecision(
          run.workspace,
          run.id,
          value.revision,
          actor,
          option,
        );
      }
      if (["review", "mute", "dismiss"].includes(name)) {
        if (!this.d.monitor)
          throw new WorkflowError("Assumption monitoring is not configured.");
        const message =
          name === "review"
            ? await this.d.monitor.review(decision)
            : name === "mute"
              ? await this.d.monitor.mute(decision, actor, action.action_ts)
              : await this.d.monitor.dismiss(decision, actor);
        await this.tell(a.user.id, run.thread, message);
        return;
      }
      await this.display(run, decision);
    } catch (error) {
      await this.failure(a.user.id, a.message.ts, error);
    }
  }
  async handleReply(event: {
    workspace: string;
    channel: string;
    thread: string;
    user: string;
    ts: string;
    text: string;
  }) {
    if (
      event.workspace !== this.d.workspace ||
      event.channel !== this.d.channel
    )
      return;
    const ref = await this.d.records.get(
      event.workspace,
      "slack-thread",
      `${event.channel}:${event.thread}`,
      z.object({ id: z.string() }),
    );
    if (!ref) return;
    try {
      const current = await this.d.workflow.get(event.workspace, ref.id);
      const question = current.followUps.find(
        (f) =>
          (f.status === "CONFIRMED" ||
            (f.status === "ANSWERED" &&
              f.answer?.sourceId ===
                stableId(event.workspace, event.channel, event.ts))) &&
          f.target?.actorId === event.user,
      );
      if (!question || !event.text.startsWith(question.questionId + ":"))
        return;
      const answer = event.text.slice(question.questionId.length + 1).trim();
      if (!answer || answer.length > 6000)
        throw new WorkflowError(
          "Reply must contain 1–6000 characters after the question ID.",
        );
      const run = await this.run(event.workspace, ref.id);
      const result = await this.d.workflow.resumeWithEvidence(
        event.workspace,
        ref.id,
        question.questionId,
        {
          actor: this.actor(event.user),
          text: answer,
          receivedAt: new Date(Number(event.ts) * 1000).toISOString(),
          sourceId: stableId(event.workspace, event.channel, event.ts),
        },
      );
      await this.display(run, result);
    } catch (error) {
      await this.failure(event.user, event.thread, error);
    }
  }
}
