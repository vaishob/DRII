import type { Decision } from "../contracts/index.js";
import type { Blocks } from "./ports.js";

export const LIVE_ACTIONS = [
  "refresh",
  "evidence",
  "challenge",
  "request",
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
    text: text.slice(0, 2800) || "No detail available.",
  },
});
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
  }
  if (d.state === "READY_FOR_REVIEW") {
    const approve = button("Approve decision", "approve", d);
    blocks.push({
      type: "actions",
      block_id: `option_${d.revision}`,
      elements: [
        {
          type: "static_select",
          action_id: "drii_live_option",
          placeholder: { type: "plain_text", text: "Choose an option" },
          options: d.options.map((o) => ({
            text: { type: "plain_text", text: o.title.slice(0, 75) },
            value: o.optionId,
          })),
        },
        {
          ...approve,
          confirm: {
            title: { type: "plain_text", text: "Approve selected option?" },
            text: {
              type: "plain_text",
              text: `Owner: ${d.owner.displayName}. Confirm the selected option and review the proposed owners and dates shown above. Approval records exactly revision ${d.revision}; unassigned owners and dates remain unset.`,
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
        ? `Approved by ${d.approval.actor.displayName} at ${d.approval.approvedAt}; option ${d.approval.optionId}, reviewed revision ${d.approval.approvedRevision}. Later evidence does not change this record.`
        : "Awaiting human approval. Participant replies are testimony. Synthetic sources are labeled in evidence details.",
    ),
  );
  return blocks;
}
