import { DOWNLOAD_TIMEOUT_MS } from "../config/limits.js";
import { IntakeError } from "../slack/errors.js";

const SLACK_FILE_HOST = "files.slack.com";

export async function downloadSlackFile(
  url: string,
  token: string,
  maxBytes: number,
  fetchFile: typeof fetch = fetch,
): Promise<Uint8Array> {
  try {
    const target = new URL(url);
    if (
      target.protocol !== "https:" ||
      target.hostname !== SLACK_FILE_HOST ||
      target.port ||
      target.username ||
      target.password
    ) {
      throw new IntakeError(
        "UNTRUSTED_FILE_URL",
        "The attachment did not have a supported Slack download URL. Please re-upload it or paste a transcript.",
      );
    }
    // Never forward the bot credential through an unvalidated redirect.
    const response = await fetchFile(target, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) {
      throw new IntakeError(
        "DOWNLOAD_FAILED",
        "DRII cannot download this attachment. Check that it is shared in the demo channel and try a new mention.",
      );
    }
    const declaredSize = Number(response.headers.get("content-length"));
    if (declaredSize > maxBytes) {
      await response.body.cancel();
      throw new IntakeError(
        "FILE_TOO_LARGE",
        "This attachment exceeds the supported size. Upload a shorter recording or paste a transcript.",
      );
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytesRead = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value.byteLength;
        if (bytesRead > maxBytes) {
          await reader.cancel();
          throw new IntakeError(
            "FILE_TOO_LARGE",
            "This attachment exceeds the supported size. Upload a shorter recording or paste a transcript.",
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (bytesRead === 0)
      throw new IntakeError("EMPTY_FILE", "The uploaded file is empty.");
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof IntakeError) throw error;
    throw new IntakeError(
      "DOWNLOAD_FAILED",
      "The Slack file download failed or timed out. Re-upload the file or paste a transcript.",
    );
  }
}
