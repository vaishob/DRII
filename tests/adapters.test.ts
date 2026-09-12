import { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config/index.js";
import { MAX_STORED_RUNS, RUN_TTL_MS } from "../src/config/limits.js";
import { createSlackPort } from "../src/slack/adapter.js";
import { MemoryRunStore } from "../src/slack/run-store.js";
import { CHANNEL_ID, ROOT_TS } from "./helpers.js";

describe("Slack API adapter", () => {
  it("queries the exact parent timestamp and rejects a different returned message", async () => {
    const client = new WebClient("test-only");
    const history = vi
      .spyOn(client.conversations, "history")
      .mockResolvedValue({
        ok: true,
        messages: [{ ts: ROOT_TS, text: "Meeting", files: [{ id: "F1" }] }],
      });
    const adapter = createSlackPort(client);
    await expect(adapter.getMessage(CHANNEL_ID, ROOT_TS)).resolves.toEqual({
      ts: ROOT_TS,
      text: "Meeting",
      fileIds: ["F1"],
    });
    expect(history).toHaveBeenCalledWith({
      channel: CHANNEL_ID,
      latest: ROOT_TS,
      inclusive: true,
      limit: 1,
    });
    history.mockResolvedValue({
      ok: true,
      messages: [{ ts: "unrelated", text: "Private unrelated content" }],
    });
    await expect(adapter.getMessage(CHANNEL_ID, ROOT_TS)).rejects.toMatchObject(
      { code: "SOURCE_NOT_FOUND" },
    );
  });

  it("requires usable file metadata", async () => {
    const client = new WebClient("test-only");
    vi.spyOn(client.files, "info").mockResolvedValue({
      ok: true,
      file: { id: "F1" },
    });
    await expect(createSlackPort(client).getFile("F1")).rejects.toMatchObject({
      code: "FILE_UNAVAILABLE",
    });
  });
});

describe("explicit configuration", () => {
  const supplied = {
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_APP_TOKEN: "xapp-test",
    SLACK_DEMO_CHANNEL_ID: CHANNEL_ID,
  };
  it("allows transcript-only mode without an OpenAI key", () => {
    expect(parseConfig(supplied).DRII_ANALYSIS_MODE).toBe("fixture");
  });
  it("rejects an unwired live-analysis mode", () => {
    expect(() =>
      parseConfig({ ...supplied, DRII_ANALYSIS_MODE: "live" }),
    ).toThrow("DRII_ANALYSIS_MODE");
  });
  it("reports field names without echoing invalid token values", () => {
    expect(() =>
      parseConfig({ ...supplied, SLACK_BOT_TOKEN: "private-secret" }),
    ).toThrow("SLACK_BOT_TOKEN");
    expect(() =>
      parseConfig({ ...supplied, SLACK_BOT_TOKEN: "private-secret" }),
    ).not.toThrow("private-secret");
  });
});

describe("bounded temporary session storage", () => {
  const context = {
    workspaceId: "TDEMO",
    channelId: CHANNEL_ID,
    threadTs: ROOT_TS,
  };
  it("deduplicates keys and expires completed sessions", () => {
    let now = 0;
    const store = new MemoryRunStore(() => now);
    const run = store.claim("key", context);
    expect(run).toBeDefined();
    expect(store.claim("key", context)).toBeUndefined();
    if (!run) throw new Error("Missing run");
    run.status = "COMPLETED";
    store.save(run);
    now = RUN_TTL_MS;
    expect(store.get(run.id)).toBeUndefined();
  });
  it("does not silently evict active runs to make space", () => {
    const store = new MemoryRunStore();
    for (let index = 0; index < MAX_STORED_RUNS; index += 1)
      store.claim(String(index), context);
    expect(() => store.claim("overflow", context)).toThrow("CAPACITY");
  });
});
