import type { Decision } from "../contracts/index.js";
import type { Blocks } from "./ports.js";

export const LIVE_ACTIONS = [
  "refresh",
  "evidence",
  "details",
  "challenge",
  "request",
  "retry_request",
  "approve",
  "changes",
  "review",
  "mute",
  "dismiss",
  "option",
  "recipient",
] as const;
export const section = (text: string): Blocks[number] => ({
  type: "section",
  text: {
    type: "plain_text",
    text:
      (text.length > 2800
        ? text.slice(0, 2700) + "\n… Open Full review for the remaining detail."
        : text) || "No detail available.",
  },
});
/** Split rather than truncate evidence or approval conditions. Keep each delivery well below Slack limits. */
export function detailBatches(details: string[]): Blocks[] {
  const batches: Blocks[] = [];
  let batch: Blocks = [];
  let characters = 0;
  for (const text of details) {
    const content = text || "No detail available.";
    for (let offset = 0; offset < content.length;) {
      let end = Math.min(offset + 2800, content.length);
      const last = content.charCodeAt(end - 1);
      if (end < content.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
      const piece = content.slice(offset, end);
      offset = end;
      if (batch.length >= 40 || characters + piece.length > 24_000) {
        batches.push(batch);
        batch = [];
        characters = 0;
      }
      batch.push({
        type: "section",
        text: { type: "plain_text", text: piece },
      });
      characters += piece.length;
    }
  }
  if (batch.length) batches.push(batch);
  return batches;
}
export function evidenceDetails(d: Decision): string[] {
  return d.evidence.length
    ? d.evidence.map(
        (e) =>
          `${e.synthetic ? "SYNTHETIC · " : ""}${e.sourceType} · ${e.sourceTitle}\nEvidence ID: ${e.evidenceId}\nSource: ${e.sourceId}, revision ${e.sourceRevision}; ${e.sourceDate}\nOwner: ${e.owner?.displayName ?? "unknown"}\n${e.sourceUrl}\nExact excerpt:\n${e.excerpt}\nMetrics: ${e.metrics.map((m) => `${m.name}: ${m.value} ${m.unit} (${m.measuredAt})`).join("; ") || "None; statements are not measured metrics."}`,
      )
    : ["No retrieved evidence. Missing evidence is not proof of falsehood."];
}
export function reviewDetails(d: Decision): string[] {
  const review = d.analysis?.review;
  return [
    `Decision ${d.decisionId} · revision ${d.revision} · ${d.state}\n${d.title}\n${d.summary}`,
    ...d.claims.map(
      (c) =>
        `${c.claimId} · ${c.status}: ${c.text}\n${c.explanation}\nEvidence IDs: ${c.evidenceIds.join(", ") || "None"}\nTranscript segments: ${c.sourceIds.join(", ")}`,
    ),
    ...(d.analysis?.criteria ?? []).map(
      (c) =>
        `Common criterion ${c.id} · ${c.kind}${c.inferred ? " (inferred; human confirmation needed)" : ""}\n${c.description}\nSpeaker: ${c.speakerLabel ?? "unknown"}; transcript ${c.segmentId}\nExact quote: ${c.quote}`,
    ),
    ...(review?.criterionAssessments ?? []).map(
      (a) =>
        `${d.options.find((o) => o.optionId === a.optionId)?.title ?? a.optionId} against ${a.criterionId}\n${a.assessment}\n${a.citations.map((c) => `Evidence ${c.evidenceId}: ${c.quote}`).join("\n") || "No evidence citation; uncertainty remains."}`,
    ),
    ...d.findings.map(
      (f) =>
        `${f.kind}\n${f.text}\nEvidence IDs: ${f.evidenceIds.join(", ") || "None"}`,
    ),
    ...d.options.map(
      (o) =>
        `Option ${o.optionId}: ${o.title}\n${o.description}\n${review?.comparison.find((c) => c.optionId === o.optionId)?.assessment ?? "No assessment"}`,
    ),
    `Conditional recommendation: ${d.options.find((o) => o.optionId === d.recommendedOptionId)?.title ?? "None"}\n${review?.recommendation.conditions.join("\n") || "No conditions recorded"}\nUnresolved disagreement: ${d.analysis?.extraction.disagreements.join("\n") || "None recorded"}`,
    ...d.actions.map(
      (a) =>
        `Action ${a.actionId} · sequence ${a.order}\n${a.description}\nProposed date: ${a.dueAt ?? "unset"}`,
    ),
    ...(review?.assumptions ?? []).map(
      (a) =>
        `Assumption ${a.id}: ${a.text}\nSource: ${a.sourceId ?? "unknown"}; metric: ${a.metricName ?? "unknown"} ${a.operator ?? ""} ${a.threshold ?? ""} ${a.unit ?? ""}\nProposed owner: ${a.proposedOwner ?? "unassigned"}; review date: ${a.reviewAt ?? "unset"}`,
    ),
    ...d.followUps.map(
      (q) =>
        `Follow-up ${q.questionId} · ${q.status}\n${q.question}\nRecipient: ${q.target?.displayName ?? "unconfirmed"}\n${q.answer ? `Attributed reply from ${q.answer.actor.displayName} at ${q.answer.receivedAt}:\n${q.answer.text}\nSource: ${q.answer.sourceId}` : "No answer yet"}`,
    ),
    ...(d.analysis?.gaps ?? []).map((g) => `Evidence gap: ${g}`),
    d.approval
      ? `Approved by ${d.approval.actor.displayName} at ${d.approval.approvedAt}; option ${d.approval.optionId}; reviewed revision ${d.approval.approvedRevision}.\n${d.approval.rationale ?? ""}`
      : "Awaiting explicit human approval. Proposed ownership and dates remain unconfirmed.",
  ];
}
function button(label: string, action: string, decision: Decision) {
  return {
    type: "button" as const,
    text: { type: "plain_text" as const, text: label },
    action_id: `drii_live_${action}`,
    value: JSON.stringify({
      id: decision.decisionId,
      revision: decision.revision,
    }),
  };
}
export function liveCard(d: Decision): Blocks {
  const reviewed = d.claims.filter(
    (c) => c.status !== "INSUFFICIENT_EVIDENCE",
  ).length;
  const review = d.analysis?.review;
  const blocks: Blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `DRII · ${d.state} · revision ${d.revision}`,
      },
    },
    section(d.title),
    section(d.summary),
    section(
      `${reviewed} of ${d.claims.length} critical claims checked: ${d.claims.filter((c) => c.status === "SUPPORTED").length} supported, ${d.claims.filter((c) => c.status === "CONTRADICTED").length} contradicted, ${d.claims.length - reviewed} unverified.\nDecision owner: ${d.owner.displayName} (${d.owner.actorId}).`,
    ),
    ...d.claims.map((c) =>
      section(
        `${c.status}: ${c.text}\n${c.explanation}\nEvidence: ${c.evidenceIds.join(", ") || "None"}; transcript: ${c.sourceIds.join(", ")}`,
      ),
    ),
    section(
      `Priorities\n${d.analysis?.extraction.priorities.map((p) => `${p.kind}${p.inferred ? " (inferred; please confirm)" : ""}: ${p.description} [${p.segmentId}]`).join("\n") || "Not stated."}`,
    ),
    ...(d.analysis?.criteria?.length
      ? [
          section(
            `Shared decision criteria\n${d.analysis.criteria.map((c) => `${c.id} · ${c.kind}: ${c.description}`).join("\n")}\nFull review compares every option against these same criteria. No numerical weights or consensus are assumed.`,
          ),
        ]
      : []),
    ...d.findings.map((f) => section(f.text)),
    section(
      `Options\n${review?.comparison.map((c) => `${d.options.find((o) => o.optionId === c.optionId)?.title}: ${c.assessment}`).join("\n") || d.options.map((o) => o.title).join("\n") || "Awaiting clarification."}`,
    ),
    section(
      `Conditional recommendation: ${d.options.find((o) => o.optionId === d.recommendedOptionId)?.title ?? "None"}\n${review?.recommendation.conditions.join("\n") || ""}\nUnresolved disagreement: ${d.analysis?.extraction.disagreements.join("; ") || "None recorded."}`,
    ),
    section(
      `Proposed actions\n${d.actions.map((a) => `${a.order}. ${a.description}; proposed date: ${a.dueAt ?? "unset"}`).join("\n") || "None yet."}`,
    ),
    section(
      `Assumption contract\n${review?.assumptions.map((a) => `${a.text}; metric: ${a.metricName ?? "unknown"} ${a.operator ?? ""} ${a.threshold ?? ""} ${a.unit ?? ""}; proposed owner: ${a.proposedOwner ?? "unassigned"}; review: ${a.reviewAt ?? "unset"}`).join("\n") || "None yet."}`,
    ),
  ];
  if (d.analysis?.gaps.length)
    blocks.push(section(`Evidence gaps\n${d.analysis.gaps.join("\n")}`));
  if (d.failure) blocks.push(section(d.failure.message));
  const pending = d.followUps.find((f) => f.status !== "ANSWERED");
  if (pending) {
    blocks.push(
      section(
        `Follow-up preview\n${pending.question}\n${pending.target ? `Waiting for ${pending.target.displayName}. Reply in this thread with ${pending.questionId}: your answer.` : "The decision owner selects a recipient, then sends this question in this thread."}`,
      ),
    );
    if (pending.status === "PROPOSED")
      blocks.push({
        type: "actions",
        block_id: `recipient_${d.revision}`,
        elements: [
          {
            type: "users_select",
            action_id: "drii_live_recipient",
            placeholder: {
              type: "plain_text",
              text: "Select actual recipient",
            },
          },
          button("Send follow-up", "request", d),
        ],
      });
    else if (pending.status === "CONFIRMED") {
      blocks.push({
        type: "actions",
        elements: [
          {
            ...button("Retry delivery", "retry_request", d),
            confirm: {
              title: { type: "plain_text", text: "Retry uncertain delivery?" },
              text: {
                type: "plain_text",
                text: "Check the thread first. If the previous send reached Slack but its acknowledgement was lost, retrying may post the same question twice. This keeps the same recipient and question ID.",
              },
              confirm: { type: "plain_text", text: "Retry delivery" },
              deny: { type: "plain_text", text: "Cancel" },
            },
          },
        ],
      });
    }
  }
  if (d.state === "READY_FOR_REVIEW" && d.recommendedOptionId !== null) {
    const approve = button("Approve decision", "approve", d);
    blocks.push({
      type: "actions",
      block_id: `option_${d.revision}`,
      elements: [
        {
          type: "static_select",
          action_id: "drii_live_option",
          placeholder: {
            type: "plain_text",
            text: "Select reviewed recommendation",
          },
          options: d.options
            .map((o, index) => ({ o, index }))
            .filter(({ o }) => o.optionId === d.recommendedOptionId)
            .map(({ o, index }) => ({
              text: { type: "plain_text", text: o.title.slice(0, 75) },
              value: `option:${index}`,
            })),
        },
        {
          ...approve,
          confirm: {
            title: { type: "plain_text", text: "Approve selected option?" },
            text: {
              type: "plain_text",
              text: `Owner: ${d.owner.displayName}. Confirm the reviewed recommendation and its conditions, proposed owners, and dates. Approval records revision ${d.revision}; unassigned owners and dates remain unset. Review another option before approving it.`,
            },
            confirm: { type: "plain_text", text: "Approve" },
            deny: { type: "plain_text", text: "Cancel" },
          },
        },
      ],
    });
  }
  blocks.push({
    type: "actions",
    elements: [
      button("Refresh", "refresh", d),
      button("Show evidence", "evidence", d),
      button("Full review", "details", d),
      ...(d.state !== "APPROVED"
        ? [
            button(
              d.state === "FAILED" ? "Retry review" : "Challenge decision",
              "challenge",
              d,
            ),
            button("Request changes", "changes", d),
          ]
        : [
            button("Review now", "review", d),
            button("Toggle mute", "mute", d),
            button("Dismiss update", "dismiss", d),
          ]),
    ],
  });
  blocks.push(
    section(
      d.approval
        ? `Approved by ${d.approval.actor.displayName} at ${d.approval.approvedAt}; option ${d.approval.optionId}, reviewed revision ${d.approval.approvedRevision}. Later evidence does not change this record.\nRetrieve this saved record with @DRII open ${d.decisionId}.`
        : `Awaiting human approval. Participant replies are testimony. Synthetic sources are labeled in evidence details.\nDecision ID: ${d.decisionId}.`,
    ),
  );
  return blocks;
}
