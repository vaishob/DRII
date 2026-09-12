import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createTranscriber } from "../src/audio/transcribe.js";
import { ACTION_SHOW_EVIDENCE } from "../src/config/limits.js";
import { createController } from "../src/slack/controller.js";
import { fixtureAnalyzer } from "../src/slack/fixture-analyzer.js";
import type { Blocks, SlackPort } from "../src/slack/ports.js";
import { MemoryRunStore } from "../src/slack/run-store.js";

const transcript = readFileSync(
  new URL("../fixtures/launch-transcript.txt", import.meta.url),
  "utf8",
);
const events: { operation: string; text: string; blocks?: Blocks }[] = [];
const statusTs = "1700000000.000003";
const threadTs = "1700000000.000001";
let meetingId = "";
const unsupported = async (): Promise<never> => {
  throw new Error("Unexpected external dependency in offline demo");
};
const slack: SlackPort = {
  getMessage: unsupported,
  getFile: unsupported,
  async post(_channel, thread, text) {
    assert.equal(thread, threadTs);
    events.push({ operation: "post", text });
    return statusTs;
  },
  async update(_channel, _ts, text, blocks) {
    events.push({ operation: "update", text, ...(blocks ? { blocks } : {}) });
  },
  async ephemeral(_channel, _user, thread, text, blocks) {
    assert.equal(thread, threadTs);
    events.push({
      operation: "ephemeral",
      text,
      ...(blocks ? { blocks } : {}),
    });
  },
};
const controller = createController({
  slack,
  channelId: "CDEMO",
  transcriber: createTranscriber(),
  download: unsupported,
  store: new MemoryRunStore(),
  analyzer: {
    mode: "fixture",
    async analyzeDecision(meeting, signal) {
      meetingId = meeting.meetingId;
      return fixtureAnalyzer.analyzeDecision(meeting, signal);
    },
  },
  logger: {
    warn: () => {},
    error: () => {
      throw new Error("Offline demo failed");
    },
  },
});
const request = {
  workspaceId: "TDEMO",
  channelId: "CDEMO",
  userId: "UALICE",
  ts: "1700000000.000002",
  threadTs,
  text: `<@UBOT> analyze\n${transcript}`,
};
await controller.handleMention(request, "UBOT");
await controller.handleMention(request, "UBOT");
await controller.handleAction({
  team: { id: "TDEMO" },
  channel: { id: "CDEMO" },
  user: { id: "UREVIEWER" },
  message: { ts: statusTs },
  actions: [{ action_id: ACTION_SHOW_EVIDENCE, value: meetingId }],
});
assert.equal(events.filter((event) => event.operation === "post").length, 1);
assert.equal(events.at(-1)?.operation, "ephemeral");
process.stdout.write(
  `${JSON.stringify({ mode: "offline-fixture", externalCalls: 0, duplicateSuppressed: true, events }, null, 2)}\n`,
);
