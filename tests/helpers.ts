import { vi } from "vitest";
import type { Transcriber } from "../src/contracts/intake.js";
import {
  createController,
  type ControllerDependencies,
} from "../src/slack/controller.js";
import { fixtureAnalyzer } from "../src/slack/fixture-analyzer.js";
import { textSegments, type Mention } from "../src/slack/input.js";
import type { SlackPort } from "../src/slack/ports.js";
import { MemoryRunStore } from "../src/slack/run-store.js";

export const BOT_ID = "UBOT";
export const CHANNEL_ID = "CDEMO";
export const ROOT_TS = "1700000000.000001";
export const STATUS_TS = "1700000000.000003";
export const TRANSCRIPT =
  "Sales: Launch Monday.\nEngineering: There are critical bugs.\nProduct: Can we run a limited beta?";
export const mention: Mention = {
  workspaceId: "TDEMO",
  channelId: CHANNEL_ID,
  userId: "UALICE",
  ts: "1700000000.000002",
  threadTs: ROOT_TS,
  text: `<@${BOT_ID}> analyze\n${TRANSCRIPT}`,
};

export function harness(overrides: Partial<ControllerDependencies> = {}) {
  const slack = {
    getMessage: vi
      .fn<SlackPort["getMessage"]>()
      .mockResolvedValue({ ts: ROOT_TS, text: "Meeting", fileIds: ["FDEMO"] }),
    getFile: vi.fn<SlackPort["getFile"]>().mockResolvedValue({
      id: "FDEMO",
      name: "meeting.mp3",
      size: 3,
      mimetype: "audio/mpeg",
      downloadUrl: "https://files.slack.com/files-pri/FDEMO/meeting.mp3",
    }),
    post: vi.fn<SlackPort["post"]>().mockResolvedValue(STATUS_TS),
    update: vi.fn<SlackPort["update"]>().mockResolvedValue(undefined),
    ephemeral: vi.fn<SlackPort["ephemeral"]>().mockResolvedValue(undefined),
  };
  const transcriber = {
    transcribeMeeting: vi
      .fn<Transcriber["transcribeMeeting"]>()
      .mockResolvedValue(textSegments(TRANSCRIPT)),
  };
  const analyzer = {
    mode: fixtureAnalyzer.mode,
    analyzeDecision: vi.fn(fixtureAnalyzer.analyzeDecision),
  };
  const download = vi
    .fn<ControllerDependencies["download"]>()
    .mockResolvedValue(new Uint8Array([1, 2, 3]));
  const store = new MemoryRunStore();
  const logger = { warn: vi.fn(), error: vi.fn() };
  const controller = createController({
    slack,
    transcriber,
    analyzer,
    download,
    store,
    logger,
    channelId: CHANNEL_ID,
    ...overrides,
  });
  return { controller, slack, transcriber, analyzer, download, store, logger };
}
