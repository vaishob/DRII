import {
  ACTION_SHOW_EVIDENCE,
  ACTION_SHOW_TRANSCRIPT,
  MAX_CARD_TEXT,
  MAX_TRANSCRIPT_PREVIEW,
} from "../config/limits.js";
import type { DecisionView, Meeting } from "../contracts/intake.js";
import type { Blocks } from "./ports.js";

function clip(text: string, limit = MAX_CARD_TEXT): string {
  return text.length > limit ? `${text.slice(0, limit - "…".length)}…` : text;
}

function section(text: string): Blocks[number] {
  return {
    type: "section",
    text: { type: "plain_text", text: clip(text), emoji: false },
  };
}

export const FIXTURE_NOTICE =
  "UI DEMO — the sample decision below is not derived from your meeting. Company retrieval, red-team reasoning, and approval are not connected yet.";

export function decisionCard(
  view: DecisionView,
  meeting: Meeting,
  runId: string,
): Blocks {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "DRII · Decision X-Ray" },
    },
    section(
      view.mode === "fixture"
        ? FIXTURE_NOTICE
        : "Agent-generated review. Inspect the evidence before deciding.",
    ),
    section(
      `Received ${meeting.segments.length} transcript segments. Speaker identities are unverified unless explicitly mapped.`,
    ),
    section(view.question),
    section(`Options\n${view.options.join("\n") || "No options provided."}`),
    ...view.findings.map((finding) =>
      section(
        `${finding.status}\n${finding.claim}\n${finding.explanation}\nSources: ${finding.sourceIds.join(", ") || "None"}`,
      ),
    ),
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: ACTION_SHOW_EVIDENCE,
          text: { type: "plain_text", text: "Show evidence" },
          value: runId,
        },
        {
          type: "button",
          action_id: ACTION_SHOW_TRANSCRIPT,
          text: { type: "plain_text", text: "Show transcript" },
          value: runId,
        },
      ],
    },
    section(
      "Demo-session storage only. This card expires after one hour or a service restart. No decision has been approved.",
    ),
  ];
}

export function evidenceCard(view: DecisionView): Blocks {
  return [
    section(
      view.mode === "fixture"
        ? "SYNTHETIC UI FIXTURE — these excerpts are sample data, not retrieved company evidence."
        : "Evidence excerpts",
    ),
    ...view.sources.map((source) =>
      section(
        `${source.synthetic ? "[SYNTHETIC] " : ""}${source.id} — ${source.title}\n${source.excerpt}`,
      ),
    ),
    ...(view.sources.length === 0
      ? [section("No supporting sources are available.")]
      : []),
  ];
}

export function transcriptCard(meeting: Meeting): Blocks {
  const preview = meeting.segments
    .map((s) => `${s.speakerLabel ?? "Unknown speaker"}: ${s.text}`)
    .join("\n");
  return [
    section(
      `Submitted transcript (preview)\n${clip(preview, MAX_TRANSCRIPT_PREVIEW)}`,
    ),
  ];
}
