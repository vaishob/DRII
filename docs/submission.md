# Demonstration and submission checklist

## Primary demonstration

Allow roughly three minutes, adjusting to the event's confirmed limit:

1. Show the prepared synthetic meeting and identify its scope (20 seconds).
2. Submit the transcript/recording in Slack. Inspect a source-backed contradiction, an unverified claim and the missing Support perspective (45 seconds plus actual processing latency).
3. Open evidence and challenge the leading option. Show source dates and why missing evidence does not mean false (30 seconds).
4. The owner selects a real teammate; the teammate replies to the exact question in the allowlisted thread. Show the changed condition and remaining disagreement (45 seconds).
5. The owner selects and confirms an option. Restart/reload the decision and show the actor/revision, ordered actions and explicit assumptions (30 seconds).
6. If time permits, demonstrate a labeled simulated support change or activated room capture. These are optional additions, not substitutes for the primary live proof.

## Backup material

`artifacts/room-demo-backup.webm` is a screen recording of the real local room interface using explicitly scripted offline adapters. Playback is slowed for readability; its duration is not application latency. `artifacts/room-review.png` captures the evidence view. Use `npm run demo:offline`, `npm run eval:offline`, and `npm run demo:room` when accounts are unavailable. Clearly describe these as offline demonstrations. Record a full live Slack backup after the account-based rehearsal passes.

## Judging evidence

| Criterion                         | Concrete proof to show                                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Core Requirements & Functionality | Input → grounded review → participant reply → owner approval → record after restart, including one recoverable error.                  |
| Innovation & Theme Alignment      | A sourced objection and a targeted question that changes a recommendation within the team's conversation.                              |
| Technical Execution & Integration | Actual ClickHouse/source inspection, validated model responses, duplicate handling, recovery, and recorded evaluation/latency results. |
| Usefulness & Agentic Experience   | Competing priorities remain visible; people choose the recipient and final option; actions/assumptions make the next steps explicit.   |

## Handoff checks

- [ ] Confirm the actual demo time limit and submission URL.
- [ ] A second teammate completes the clean-start [runbook](workflow.md).
- [ ] Record real ClickHouse seed counts, source links, model configuration, retrieval and end-to-end latency.
- [ ] Run and review `eval:model` and the opt-in integration suite. Fabricated citations or false approval claims block release.
- [ ] Rehearse a provider failure, a duplicate event/action and service restart in Slack.
- [ ] Record the full live backup; verify the final repository/PR/demo links are accessible to the intended reviewers.
- [ ] Keep credentials and private workplace content out of the submitted material.

These unchecked account/event-dependent steps must be completed before declaring the hackathon submission fully verified.
