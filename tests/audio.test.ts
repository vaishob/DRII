import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { downloadSlackFile } from "../src/audio/download.js";
import { createTranscriber } from "../src/audio/transcribe.js";
import { TRANSCRIPTION_MODEL } from "../src/config/limits.js";

const FILE_URL = "https://files.slack.com/files-pri/T/F/meeting.mp3";
const TEST_LIMIT_BYTES = 4;

describe("Slack downloads", () => {
  it("authenticates only a validated Slack URL and disables redirects", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(new Uint8Array([1, 2])));
    const bytes = await downloadSlackFile(
      FILE_URL,
      "private-test-token",
      TEST_LIMIT_BYTES,
      fetcher,
    );
    expect(bytes).toEqual(Buffer.from([1, 2]));
    expect(fetcher).toHaveBeenCalledWith(
      new URL(FILE_URL),
      expect.objectContaining({
        redirect: "error",
        headers: { Authorization: "Bearer private-test-token" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each([
    "https://files.slack.com.evil.test/file",
    "http://files.slack.com/file",
    "https://user:password@files.slack.com/file",
    "https://files.slack.com:8080/file",
    "not a URL",
  ])("does not send credentials to %s", async (url) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      downloadSlackFile(url, "secret", TEST_LIMIT_BYTES, fetcher),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects oversized content even if Slack metadata/content-length underreports it", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array(TEST_LIMIT_BYTES + 1), {
        headers: { "content-length": "1" },
      }),
    );
    await expect(
      downloadSlackFile(FILE_URL, "secret", TEST_LIMIT_BYTES, fetcher),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });

  it("rejects a declared oversized body before reading it", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array([1]), {
        headers: { "content-length": String(TEST_LIMIT_BYTES + 1) },
      }),
    );
    await expect(
      downloadSlackFile(FILE_URL, "secret", TEST_LIMIT_BYTES, fetcher),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });

  it.each([401, 403, 404, 500])(
    "handles HTTP %i without exposing response content",
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("private server details", { status }));
      await expect(
        downloadSlackFile(FILE_URL, "secret", TEST_LIMIT_BYTES, fetcher),
      ).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
    },
  );

  it("handles empty bodies and network failures", async () => {
    await expect(
      downloadSlackFile(
        FILE_URL,
        "secret",
        TEST_LIMIT_BYTES,
        async () => new Response(""),
      ),
    ).rejects.toMatchObject({ code: "EMPTY_FILE" });
    await expect(
      downloadSlackFile(FILE_URL, "secret", TEST_LIMIT_BYTES, async () => {
        throw new Error("private credentials");
      }),
    ).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
  });
});

describe("OpenAI transcription adapter (mocked transport)", () => {
  it("sends the selected model/options and preserves speaker segments without identity guesses", async () => {
    let submitted: FormData | undefined;
    const client = new OpenAI({
      apiKey: "test-only",
      fetch: async (input, init) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        submitted = await request.formData();
        return new Response(
          JSON.stringify({
            text: "We should launch.",
            segments: [
              {
                id: "0",
                text: "We should launch.",
                speaker: "A",
                start: 0,
                end: 1,
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    const segments = await createTranscriber(client).transcribeMeeting(
      new Uint8Array([1, 2, 3]),
      "meeting.mp3",
    );
    expect(submitted?.get("model")).toBe(TRANSCRIPTION_MODEL);
    expect(submitted?.get("response_format")).toBe("diarized_json");
    expect(submitted?.get("chunking_strategy")).toBe("auto");
    expect(segments).toEqual([
      {
        id: "segment-0",
        text: "We should launch.",
        speakerLabel: "A",
        speakerIdentity: null,
        startSeconds: 0,
        endSeconds: 1,
      },
    ]);
  });

  it("provides a transcript fallback when no client is configured", async () => {
    await expect(
      createTranscriber().transcribeMeeting(new Uint8Array(), "x.mp3"),
    ).rejects.toMatchObject({
      code: "TRANSCRIPTION_NOT_CONFIGURED",
      userMessage: expect.stringContaining("Paste a transcript"),
    });
  });

  it.each([
    { segments: [] },
    { segments: [{ text: "x", start: 2, end: 1 }] },
    { text: "Missing diarization" },
  ])("rejects invalid speech responses", async (payload) => {
    const client = new OpenAI({
      apiKey: "test-only",
      fetch: async () =>
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(
      createTranscriber(client).transcribeMeeting(new Uint8Array([1]), "x.mp3"),
    ).rejects.toMatchObject({ code: "TRANSCRIPTION_FAILED" });
  });

  it("does not surface raw provider errors", async () => {
    const client = new OpenAI({
      apiKey: "test-only",
      fetch: async () =>
        new Response(
          JSON.stringify({ error: { message: "secret provider details" } }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    });
    await expect(
      createTranscriber(client).transcribeMeeting(new Uint8Array([1]), "x.mp3"),
    ).rejects.toMatchObject({ code: "TRANSCRIPTION_FAILED" });
  });
});
