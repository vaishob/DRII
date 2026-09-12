# Current workflow and demo runbook

## Setup

Use Node.js 24, `npm ci`, and `npm run verify`. Copy `.env.example` to `.env` only if that file does not already exist. Keep secrets local.

Configure ClickHouse, OpenAI, the real Slack team ID in `DRII_DEMO_WORKSPACE_ID`, the public allowlisted `SLACK_DEMO_CHANNEL_ID`, and the intended decision owner's Slack user ID in `DRII_DECISION_OWNER_ID`. Set `DRII_ANALYSIS_MODE=live`. Live startup validates the required fields; fixture mode remains an explicit UI rehearsal.

Run `npm run db:setup`, `npm run db:health`, and `npm run db:seed` twice. The corpus contains 10 source revisions representing 9 logical sources (8 visible and 1 restricted). Verify those counts on the actual database; prepared fixture counts alone are not a live result. Use `npm run demo:query -- "Are the blocking billing bugs fixed?"` and `npm run source:show -- engineering-readiness` to inspect exact sources.

Install/update `slack-manifest.json` in your intended workspace, enable Socket Mode and interactivity, and invite the bot to the allowlisted public channel. The manifest subscribes to `app_mention` and `message.channels`; scopes are `app_mentions:read`, `chat:write`, `channels:history`, and `files:read`, plus an app token with `connections:write`. Interactive handlers acknowledge before processing. See [Slack events](https://docs.slack.dev/apis/events-api/) and [interaction handling](https://docs.slack.dev/interactivity/handling-user-interaction/).

Start `npm run dev`, or `npm run build` followed by `npm start`. The build copies the room page into `dist/room`.

## Complete Slack loop

1. In the allowlisted channel, paste `@DRII analyze: <transcript>`, or upload one MP3/UTF-8 text file and reply `@DRII analyze this meeting`. MP3 is limited to 20 MB and a 15-minute returned transcript; duration is checked after transcription. Pasted/transcript-file text is bounded to 60,000 characters/bytes respectively.
2. DRII persists a receipt, normalizes and stores the meeting, extracts transcript-linked claims and priorities, retrieves scoped evidence, and performs a separate red-team review. A second bounded retrieval/review pass runs when needed. Missing sources remain uncertainty; a failing operation cannot create an approval.
3. Inspect the claim counts, exact evidence, disagreements, option comparison, conditions, proposed actions, and assumptions. Click **Show evidence** for exact excerpts and source dates. `drii://` references are application identifiers, not websites.
4. **Challenge decision** refreshes evidence and the review. **Request changes** shows correction instructions: `@DRII correct <decision-id> <segment-id> <corrected text>` or `@DRII map <decision-id> <segment-id> <@person>`. Only the owner can correct the transcript or map an identity; corrections create a new stored meeting revision and trigger re-extraction.
5. When a question is proposed, the owner selects the actual recipient and clicks **Send follow-up**. The exact question is previewed before that action. The selected teammate replies in the same thread with `<question-id>: <answer>`. Unrelated participants, unrelated question IDs, edits and bot messages are ignored.
6. The reply is recorded as attributed testimony, without inventing structured metrics. DRII retrieves again and explains changed claim findings and updated conditions. It keeps unanswered questions visible.
7. When ready, select the intended option and click **Approve decision**. The confirmation identifies the owner and reviewed revision and asks the owner to review proposed owners/dates. The server verifies the actor, current revision, state and option. It records the exact approved revision, actor, time and confirmation rationale. Unassigned action owners and dates remain unset; proposed commitments are not silently accepted for other people.
8. Restart the service and use `@DRII status <decision-id>` to reload the persisted card. Use `@DRII resume <decision-id>` after a recoverable failure. Retried/stale clicks cannot replace an approved decision. Start a new review to reconsider an approved choice.

Unknown speaker identities remain unknown until explicitly mapped. No model output can directly approve or send a follow-up. Documents and transcripts are untrusted data; runtime validation rejects unknown IDs and inexact citation quotes. Semantic quality still requires real model evaluations.

## Room capture and proactive review

For the integrated product, set `DRII_ROOM_ENABLED=1` and start the normal app. Open `http://127.0.0.1:3180`. Room and Slack share one writer process. **Do not run a second app/room process against the same decisions.** `npm run dev:room` is a standalone development option when the Slack app is stopped.

Start the microphone explicitly. The page sends short WebM chunks to the configured OpenAI transcription endpoint, then submits only finalized segments. The interface shows capture state, inspectable transcript, a 30-second minimum review interval, measured review latency, mute and dismiss controls. It performs no spoken output. Stop capture or close the page to release microphone tracks. The recorded-MP3/pasted-transcript path remains available if browser audio fails. Chunked capture is buffered; no continuous realtime latency is promised.

Room results provide `@DRII open <decision-id>` for opening the same persisted decision in the allowlisted Slack channel. Approval remains in Slack. Duplicate finalized segments, stopped capture, unchanged conditions, muted suggestions and dismissed evidence are handled explicitly. Loopback host/origin and a page token protect local mutation routes; this is a local room interface, not an internet deployment.

For an offline rehearsal, run `npm run demo:room`. It disables transcription and labels the model and source adapters as scripted. These adapters are imported only by tests/rehearsal commands.

Capture pauses when its upload buffer reaches three chunks. Failed audio remains in browser memory with an explicit **Retry buffered audio** button; keep the page open until it is saved. Finalized transcript requests reuse their segment ID on connection retries. Automatic reviews display elapsed time from the finalized audio chunk through transcription and review; manual reviews display server review time. Neither measurement includes the earlier eight-second recording window. Actual microphone/provider latency remains a live acceptance check.

## Assumption outcomes

An approved card offers **Review now**, **Toggle mute**, and **Dismiss update**. The monitor reads scoped current source metrics, records timestamped snapshots with source/condition/value/unit, retains UNKNOWN for missing metrics, and writes a separate REVIEW_NEEDED record for a changed violation or superseded nonmetric source. Unchanged conditions do not create repeated alerts. Only the owner can mute/dismiss, and approved decision events are never rewritten.

`npm run demo:assumptions -- <approved-decision-id>` advances only the explicitly synthetic support source using `fixtures/demo/seven-days-later.json`. It labels both the source and stored snapshot as simulated time. Run it twice to verify duplicate-alert suppression. It requires ClickHouse/OpenAI access and an approved decision in the configured demo workspace; it never mutates a non-synthetic source.

## Verification and actual accounts

- `npm run verify`: deterministic unit/controller tests, SDK tests with mocked HTTP, typecheck, lint, formatting and build.
- `npm run eval:offline`: scripted response/retrieval evaluation with an actual-results JSON artifact. This measures application invariants, not model quality.
- `npm run eval:model`: explicitly opted-in paid model calls with synthetic fixture retrieval; writes a separate model-results report. This does not claim ClickHouse retrieval.
- Set `DRII_LIVE_TESTS=1`, then `npm run test:integration`: real ClickHouse SQL, receipt persistence, approved snapshot recovery and embedding access. Leave the flag off outside intentional integration runs.
- Perform the complete Slack loop with a real teammate, exercise a provider failure, restart, and record actual source counts and latency. This cannot be replaced by the scripted tests.

Model calls allow at most two attempts per stage; retrieval has a named ten-query budget. A room request is limited to 2 MB and its context to 80 finalized segments/60,000 characters. ClickHouse writes use append-only events and explicit latest-revision reads. The supported concurrency model is one application process. Slack delivery and ClickHouse are not one transaction: a persisted send-attempt receipt prevents automatic duplicate notifications, but an ambiguous external delivery may require manual inspection of the displayed follow-up before resending.

## Data and attribution

Original Slack recordings remain in Slack; downloaded bytes and room audio chunks are temporary process/browser memory. Transcripts, decision snapshots, evidence, receipts and assumption records are stored in ClickHouse. Document chunks/queries go to the configured embedding endpoint; transcript and evidence context go to the configured reasoning endpoint. The Responses adapter requests `store:false`; this does not by itself define the provider's entire data-retention policy. Operational logging avoids raw prompts, transcripts and provider errors. Explicit source commands/cards show permitted evidence to the user.

The implementation uses OpenAI's official SDK, ClickHouse's official client, Slack Bolt/Block Kit, Zod and Pino. No sponsor integration is claimed merely because it appeared in the starter reference. A self-hosted ClickHouse endpoint is configurable but unverified; external Slack and inference still make this a cloud-connected workflow.
