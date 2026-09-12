import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTION_SHOW_EVIDENCE,
  ACTION_SHOW_TRANSCRIPT,
  ANALYSIS_TIMEOUT_MS,
  MAX_AUDIO_BYTES,
  MAX_TRANSCRIPT_CHARS,
  RUN_TTL_MS,
} from "../src/config/limits.js";
import { FIXTURE_NOTICE } from "../src/slack/cards.js";
import { IntakeError } from "../src/slack/errors.js";
import { parseCommand, textSegments } from "../src/slack/input.js";
import { fixtureAnalyzer } from "../src/slack/fixture-analyzer.js";
import {
  BOT_ID,
  CHANNEL_ID,
  ROOT_TS,
  STATUS_TS,
  TRANSCRIPT,
  harness,
  mention,
} from "./helpers.js";

afterEach(() => vi.useRealTimers());

describe("meeting input", () => {
  it("recognizes only an analyze command directed at this bot", () => {
    expect(parseCommand(`<@${BOT_ID}> analyze this meeting`, BOT_ID)).toBe("");
    expect(parseCommand(`<@${BOT_ID}> analyze: ${TRANSCRIPT}`, BOT_ID)).toBe(
      TRANSCRIPT,
    );
    expect(parseCommand("<@UOTHER> analyze", BOT_ID)).toBeNull();
    expect(parseCommand(`<@${BOT_ID}> analyzer`, BOT_ID)).toBeNull();
    expect(parseCommand(`<@${BOT_ID}> hello`, BOT_ID)).toBeNull();
  });

  it("preserves labels without guessing employee identities or timestamps", () => {
    const segments = textSegments("Sales: Launch now.\nUnlabeled thought");
    expect(segments[0]).toMatchObject({
      speakerLabel: "Sales",
      speakerIdentity: null,
      startSeconds: null,
    });
    expect(segments[1]).toMatchObject({
      speakerLabel: null,
      text: "Unlabeled thought",
    });
    expect(() => textSegments(" ")).toThrow(IntakeError);
    expect(() => textSegments("x".repeat(MAX_TRANSCRIPT_CHARS + 1))).toThrow(
      IntakeError,
    );
  });

  it("sends inline text to the analyzer and renders a labeled fixture in the originating thread", async () => {
    const h = harness();
    await h.controller.handleMention(mention, BOT_ID);
    expect(h.slack.post).toHaveBeenCalledWith(
      CHANNEL_ID,
      ROOT_TS,
      expect.any(String),
    );
    expect(h.transcriber.transcribeMeeting).not.toHaveBeenCalled();
    expect(h.slack.getMessage).not.toHaveBeenCalled();
    const meeting = h.analyzer.analyzeDecision.mock.calls[0]?.[0];
    expect(meeting?.segments).toHaveLength(3);
    expect(meeting?.workspaceId).toBe(mention.workspaceId);
    const card = JSON.stringify(h.slack.update.mock.calls.at(-1));
    expect(card).toContain(FIXTURE_NOTICE);
    expect(card).toContain(ACTION_SHOW_EVIDENCE);
    expect(card).not.toContain("Approve");
  });

  it("uses the new message as the thread root when there is no parent", async () => {
    const h = harness();
    const { threadTs: _thread, ...rootMention } = mention;
    void _thread;
    await h.controller.handleMention(rootMention, BOT_ID);
    expect(h.slack.post).toHaveBeenCalledWith(
      CHANNEL_ID,
      mention.ts,
      expect.any(String),
    );
  });

  it("deduplicates concurrently delivered events before any slow work", async () => {
    const h = harness();
    await Promise.all([
      h.controller.handleMention(mention, BOT_ID),
      h.controller.handleMention(mention, BOT_ID),
    ]);
    expect(h.slack.post).toHaveBeenCalledTimes(1);
    expect(h.analyzer.analyzeDecision).toHaveBeenCalledTimes(1);
  });

  it("ignores other channels, bot messages, and unrelated mentions", async () => {
    const h = harness();
    await h.controller.handleMention(
      { ...mention, channelId: "COTHER" },
      BOT_ID,
    );
    await h.controller.handleMention({ ...mention, botId: "BBOT" }, BOT_ID);
    await h.controller.handleMention({ ...mention, userId: BOT_ID }, BOT_ID);
    await h.controller.handleMention(
      { ...mention, text: `<@${BOT_ID}> hello` },
      BOT_ID,
    );
    expect(h.slack.post).not.toHaveBeenCalled();
  });

  it("loads an MP3 from the exact parent and feeds transcription to the same analyzer", async () => {
    const h = harness();
    await h.controller.handleMention(
      { ...mention, text: `<@${BOT_ID}> analyze this meeting` },
      BOT_ID,
    );
    expect(h.slack.getMessage).toHaveBeenCalledWith(CHANNEL_ID, ROOT_TS);
    expect(h.download).toHaveBeenCalledWith(
      expect.stringContaining("files.slack.com"),
      MAX_AUDIO_BYTES,
    );
    expect(h.transcriber.transcribeMeeting).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3]),
      "meeting.mp3",
    );
    expect(h.analyzer.analyzeDecision.mock.calls[0]?.[0].source).toEqual({
      kind: "audio",
      referenceId: "FDEMO",
    });
    expect(JSON.stringify(h.slack.update.mock.calls)).toContain(
      "Transcribing audio",
    );
  });

  it("accepts a UTF-8 text attachment without invoking speech-to-text", async () => {
    const h = harness();
    h.slack.getFile.mockResolvedValue({
      id: "FTEXT",
      name: "meeting.txt",
      size: TRANSCRIPT.length,
      mimetype: "text/plain",
      downloadUrl: "https://files.slack.com/text",
    });
    h.download.mockResolvedValue(new TextEncoder().encode(TRANSCRIPT));
    await h.controller.handleMention(
      { ...mention, text: `<@${BOT_ID}> analyze` },
      BOT_ID,
    );
    expect(h.transcriber.transcribeMeeting).not.toHaveBeenCalled();
    expect(h.analyzer.analyzeDecision).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid UTF-8", async () => {
    const h = harness();
    h.slack.getFile.mockResolvedValue({
      id: "FTEXT",
      name: "meeting.txt",
      size: 1,
      mimetype: "text/plain",
      downloadUrl: "https://files.slack.com/text",
    });
    h.download.mockResolvedValue(new Uint8Array([0xff]));
    await h.controller.handleMention(
      { ...mention, text: `<@${BOT_ID}> analyze` },
      BOT_ID,
    );
    expect(h.analyzer.analyzeDecision).not.toHaveBeenCalled();
    expect(JSON.stringify(h.slack.update.mock.calls)).toContain("UTF-8");
  });

  it("accepts a parent transcript without an attachment", async () => {
    const h = harness();
    h.slack.getMessage.mockResolvedValue({
      ts: ROOT_TS,
      text: TRANSCRIPT,
      fileIds: [],
    });
    await h.controller.handleMention(
      { ...mention, text: `<@${BOT_ID}> analyze` },
      BOT_ID,
    );
    expect(h.analyzer.analyzeDecision).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ts: "wrong", text: TRANSCRIPT, fileIds: [] },
    { ts: ROOT_TS, text: "", fileIds: [] },
    { ts: ROOT_TS, text: "", fileIds: ["F1", "F2"] },
  ])(
    "does not guess a source for invalid parent data: $fileIds",
    async (source) => {
      const h = harness();
      h.slack.getMessage.mockResolvedValue(source);
      await h.controller.handleMention(
        { ...mention, text: `<@${BOT_ID}> analyze` },
        BOT_ID,
      );
      expect(h.analyzer.analyzeDecision).not.toHaveBeenCalled();
      expect(h.logger.error).toHaveBeenCalled();
    },
  );

  it.each([
    { name: "movie.mp4", size: 10, mimetype: "video/mp4" },
    { name: "meeting.mp3", size: MAX_AUDIO_BYTES + 1, mimetype: "audio/mpeg" },
  ])(
    "rejects unsupported/oversized files before download: $name",
    async (file) => {
      const h = harness();
      h.slack.getFile.mockResolvedValue({
        id: "FBAD",
        downloadUrl: "https://files.slack.com/file",
        ...file,
      });
      await h.controller.handleMention(
        { ...mention, text: `<@${BOT_ID}> analyze` },
        BOT_ID,
      );
      expect(h.download).not.toHaveBeenCalled();
      expect(h.analyzer.analyzeDecision).not.toHaveBeenCalled();
    },
  );

  it("shows a safe error and allows a new mention after transcription failure", async () => {
    const h = harness();
    h.transcriber.transcribeMeeting.mockRejectedValueOnce(
      new Error("secret-token provider-body"),
    );
    const request = { ...mention, text: `<@${BOT_ID}> analyze` };
    await h.controller.handleMention(request, BOT_ID);
    expect(h.analyzer.analyzeDecision).not.toHaveBeenCalled();
    expect(JSON.stringify(h.slack.update.mock.calls)).not.toContain(
      "secret-token",
    );
    expect(JSON.stringify(h.logger.error.mock.calls)).not.toContain(
      "secret-token",
    );
    await h.controller.handleMention(
      { ...request, ts: "1700000001.000002" },
      BOT_ID,
    );
    expect(h.analyzer.analyzeDecision).toHaveBeenCalledTimes(1);
  });

  it("rejects invented source IDs from an analyzer", async () => {
    const h = harness();
    h.analyzer.analyzeDecision.mockImplementation(async (meeting) => {
      const view = await fixtureAnalyzer.analyzeDecision(
        meeting,
        new AbortController().signal,
      );
      return { ...view, sources: [] };
    });
    await h.controller.handleMention(mention, BOT_ID);
    expect(JSON.stringify(h.slack.update.mock.calls.at(-1))).toContain(
      "inconsistent source references",
    );
  });

  it("times out a stalled analysis and does not publish a late result", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.analyzer.analyzeDecision.mockImplementation(() => new Promise(() => {}));
    const request = h.controller.handleMention(mention, BOT_ID);
    await vi.advanceTimersByTimeAsync(ANALYSIS_TIMEOUT_MS + 1);
    await request;
    expect(JSON.stringify(h.slack.update.mock.calls.at(-1))).toContain(
      "timed out",
    );
  });
});

describe("details buttons", () => {
  async function completed() {
    const h = harness();
    await h.controller.handleMention(mention, BOT_ID);
    const id = h.analyzer.analyzeDecision.mock.calls[0]?.[0].meetingId;
    if (!id) throw new Error("Missing run");
    const body = {
      team: { id: mention.workspaceId },
      channel: { id: CHANNEL_ID },
      user: { id: "UREVIEWER" },
      message: { ts: STATUS_TS },
      actions: [{ action_id: ACTION_SHOW_EVIDENCE, value: id }],
    };
    return { ...h, body };
  }

  it("shows synthetic evidence privately in the original thread", async () => {
    const h = await completed();
    await h.controller.handleAction(h.body);
    expect(h.slack.ephemeral).toHaveBeenCalledWith(
      CHANNEL_ID,
      "UREVIEWER",
      ROOT_TS,
      expect.any(String),
      expect.any(Array),
    );
    expect(JSON.stringify(h.slack.ephemeral.mock.calls)).toContain("SYNTHETIC");
  });

  it("shows the actual submitted transcript", async () => {
    const h = await completed();
    h.body.actions[0]!.action_id = ACTION_SHOW_TRANSCRIPT;
    await h.controller.handleAction(h.body);
    expect(JSON.stringify(h.slack.ephemeral.mock.calls)).toContain(
      "Sales: Launch Monday.",
    );
  });

  it.each(["workspace", "message"])(
    "does not leak another run through a mismatched %s",
    async (field) => {
      const h = await completed();
      if (field === "workspace") h.body.team.id = "TOTHER";
      else h.body.message.ts = "1700000099.000001";
      await h.controller.handleAction(h.body);
      expect(JSON.stringify(h.slack.ephemeral.mock.calls)).toContain(
        "unavailable or expired",
      );
      expect(JSON.stringify(h.slack.ephemeral.mock.calls)).not.toContain(
        "three P0",
      );
    },
  );

  it("expires completed cards", async () => {
    vi.useFakeTimers();
    const h = await completed();
    await vi.advanceTimersByTimeAsync(RUN_TTL_MS);
    await h.controller.handleAction(h.body);
    expect(JSON.stringify(h.slack.ephemeral.mock.calls)).toContain("expired");
  });
});
