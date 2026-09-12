# Verification record — 2026-09-12

## Actual results

Windows PowerShell; official portable Node.js 24.21.0; pinned package-lock.json. Main was pulled through `c106715` (merged PR #17) into `feat/complete-decision-workflow`.

- `npm run verify` passed: TypeScript, **99 tests in 16 files**, ESLint, Prettier, and the production build. The final integrated test run started at 17:14 Singapore time and took 13.47 seconds. This is test duration, not product latency.
- `npm run eval:offline` passed **10/10** at 2026-09-12T09:14:48.957Z. [Actual JSON results](../artifacts/evaluation-offline.json) record each case. Cases cover contradiction, supported counterfactual, missing evidence, no decision, document injection, source revisions, conflicting evidence, missing stakeholder, temporary retrieval failure/recovery, and fabricated citations. Responses/retrieval are explicitly scripted; this is not evidence of model quality.
- `npm run demo:offline` passed with zero external calls and duplicate intake suppression. Full workflow controller tests separately cover targeted replies, wrong actors, stale approvals, duplicates, new controller instances, approval immutability, and recovery after an interrupted reply write.
- Real OpenAI SDK parsing is exercised with mocked HTTP: valid structured responses, bounded repair and sanitized provider errors. No paid model evaluation was run.
- Browser checks in headless Chrome passed: transcript submission, contradiction rendering, exact evidence inspection, refresh restoration, one failed request followed by exactly one stored segment, no repeated mute action after a lost response, and retry of a retained already-transcribed chunk. The latter uses synthetic text; it does not verify microphone/STT access. No browser errors appeared. The final axe 4.12.1 scan of the rendered review had zero violations, 34 passes and no incomplete checks; the earlier mobile check had no horizontal overflow. [Accessibility JSON](../artifacts/room-accessibility.json) and the [final screenshot](../artifacts/room-final.png) are saved.

The [offline room backup](../artifacts/room-demo-backup.webm) uses scripted adapters. Playback was slowed for readability; video duration is not measured application latency. [Desktop](../artifacts/room-initial.png), [review](../artifacts/room-review.png), and [mobile](../artifacts/room-mobile.png) screenshots show the rehearsal interface.

## Live acceptance remains open

No root `.env` was available. The opt-in ClickHouse integration tests, real embeddings, real model evaluation, Slack round trip, microphone transcription and second-person rehearsal have **not** been recorded as passing.

| Gate                | Required evidence                                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database and corpus | Run schema/health/seed twice on the intended endpoint. Confirm 10 revisions, 9 logical sources, 8 visible and 1 restricted. Run source/query commands.                       |
| Persistence         | Run `DRII_LIVE_TESTS=1 npm run test:integration` using the shell-specific environment syntax. Reload receipts and an approved snapshot after reconnect.                      |
| Reasoning           | Run `npm run eval:model`, review semantic source support, and record the actual model/configuration and failures.                                                            |
| Slack/audio         | Use the real allowlisted channel and owner. Rehearse audio and transcript, evidence, challenge, recipient selection, teammate reply, approval, restart and provider failure. |
| Room                | Check actual microphone permission, silent/noisy intervals, transcription quality, stop/reconnect, and finalized-audio-to-review latency.                                    |
| Submission          | Confirm the event limit/URL, complete a second-person clean start, capture a full live backup and check reviewer access to the final links.                                  |

The selected deployment profile is one laptop-hosted Node process with Slack Socket Mode, ClickHouse and configurable inference endpoints. Room and Slack share that process. Live hosting is not verified; a self-hosted ClickHouse alternative is documented only. ClickHouse and Slack delivery are not a single transaction; ambiguous message delivery requires human inspection instead of automatic resending. Raw audio pending retry exists only in browser memory until saved.

## Integration of concurrent work

PR #17 landed during this implementation. Its parallel scaffold imported schemas that the merged shared-contract barrel did not export, producing type errors. The integrated app uses `src/contracts/index.ts`, `src/contracts/services.ts`, `src/data/decisions.ts`, and `DurableDecisionWorkflow`. The incompatible duplicate scaffold and its duplicate tests were consolidated into those implementations. Its contract-validation, event deduplication/latest-revision, and workflow/source-provenance cases remain covered in `tests/contracts.test.ts`, `tests/persistence.test.ts`, and `tests/workflow.test.ts`; conflicting replay payloads are rejected explicitly. The package's intelligence entrypoint exports the working engine, model adapter and durable workflow.

See the [issue audit](implementation-progress.md) and [current runbook](workflow.md). Implemented code and passing offline checks do not by themselves close the account-dependent acceptance criteria.
