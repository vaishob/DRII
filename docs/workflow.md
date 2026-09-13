# Current workflow and demo runbook

## Setup

Use Node.js 24, `npm ci`, and `npm run verify`. Copy `.env.example` to `.env` only if that file does not already exist. Keep secrets local.

Configure ClickHouse, OpenAI, the real Slack team ID in `DRII_DEMO_WORKSPACE_ID`, the public allowlisted `SLACK_DEMO_CHANNEL_ID`, and the intended decision owner's Slack user ID in `DRII_DECISION_OWNER_ID`. Set `DRII_ANALYSIS_MODE=live`. Live startup validates the required fields; fixture mode remains an explicit UI rehearsal.

Run `npm run doctor` before starting the app. It checks Node 24, live mode and required configuration locally without making provider requests. A missing account configuration is a failure with field names, never credential values. After schema/corpus setup and Slack installation, run `npm run doctor -- --live`. This checks ClickHouse tables and scoped source chunks, the bot's workspace and channel access, one synthetic structured model response, and one synthetic embedding. The live probe uses the configured inference endpoint and incurs small model/embedding usage; it sends no Slack messages and writes no records. A passing probe leaves Socket Mode events, transcription quality and the human rehearsal pending.

Run `npm run db:setup`, `npm run db:health`, and `npm run db:seed` twice. The corpus contains 10 source revisions representing 9 logical sources (8 visible and 1 restricted). Verify those counts on the actual database; prepared fixture counts alone are not a live result. Use `npm run demo:query -- "Are the blocking billing bugs fixed?"` and `npm run source:show -- engineering-readiness` to inspect exact sources.

Install/update `slack-manifest.json` in your intended workspace, enable Socket Mode and interactivity, and invite the bot to the allowlisted public channel. The manifest subscribes to `app_mention` and `message.channels`; scopes are `app_mentions:read`, `chat:write`, `channels:history`, and `files:read`, plus an app token with `connections:write`. Interactive handlers acknowledge before processing. See [Slack events](https://docs.slack.dev/apis/events-api/) and [interaction handling](https://docs.slack.dev/interactivity/handling-user-interaction/).

Start `npm run dev`, or `npm run build` followed by `npm start`. The build copies the room page into `dist/room`.

## Import company context

The demo seed is optional for a real organization. Prepare a JSON `Source` object or array of 1–100 objects using the [shared contract examples](../fixtures/contracts/v1/examples.json). Set the actual workspace/project IDs, document owner, content, provenance URL, visibility and dates; set `synthetic:false` for real documents. The entire file must be at most 3 MB and each document at most 24,000 characters. Dates must be ordered, and metric measurement times cannot follow source availability. Each named metric has one value/unit per timestamp.

```sh
npm run source:ingest -- path/to/sources.json --dry-run
npm run source:ingest -- path/to/sources.json
npm run evidence:query -- "What constraints apply to this launch?"
npm run source:show -- source-id
npm run source:show -- source-id 2026-09-12T08:00:00Z
```

Dry-run validates the entire file locally. Import embeds workspace-visible documents and writes ClickHouse records. Restricted documents are stored without sending their content to the embedding provider or making them retrievable. Identical revisions can be retried after a partial failure; changed content or embedding model requires a new revision. Real imports must match the configured workspace/project; they are not silently reassigned. `evidence:query` and default source inspection use the current time; `demo:query` retains its historical demonstration cutoff. Import is a manual JSON connector; automatic Slack history, Google Drive and meeting-calendar synchronization are not implemented.

## Complete Slack loop

1. In the allowlisted channel, paste `@DRII analyze: <transcript>`, or upload one MP3/UTF-8 text file and reply `@DRII analyze this meeting`. MP3 is limited to 20 MB and a 15-minute returned transcript; duration is checked after transcription. Pasted/transcript-file text is bounded to 60,000 characters/bytes respectively.
2. DRII persists a receipt, normalizes and stores the meeting, extracts transcript-linked claims and priorities, retrieves scoped evidence, and performs a separate red-team review. A second bounded retrieval/review pass runs when needed. Missing sources remain uncertainty; a failing operation cannot create an approval.
3. Inspect the claim counts, exact evidence, disagreements, option comparison, conditions, proposed actions, and assumptions. **Show evidence** provides complete excerpts, IDs, source dates and metrics across bounded Slack messages. **Full review** includes the complete comparison of every option against each shared criterion. The compact card abbreviates long text; detail views preserve it. `drii://` references are application identifiers, not websites.
4. **Challenge decision** refreshes evidence and the review. **Request changes** shows correction instructions: `@DRII correct <decision-id> <segment-id> <corrected text>` or `@DRII map <decision-id> <segment-id> <@person>`. Only the owner can correct the transcript or map an identity; corrections create a new stored meeting revision and trigger re-extraction.
5. When a question is proposed, the owner selects the actual recipient and clicks **Send follow-up**. The exact question is previewed before that action. The selected teammate replies in the same thread with `<question-id>: <answer>`. Question-specific persisted routing supports multiple reviews in one thread. Unrelated participants, unrelated question IDs, edits and bot messages are ignored. If delivery is uncertain, inspect the thread, then use **Retry delivery** only if needed; it retains the same recipient and question ID. An acknowledgement lost after a successful Slack post can require this human check to avoid a duplicate message.
6. The reply is recorded as attributed testimony and supplied directly as citable evidence, even if vector search would not rank it. It does not become a verified metric. DRII retrieves again and explains changed claim findings and added/replaced recommendation conditions. Already sent question IDs survive re-review and recoverable failures.
7. When ready, select the reviewed recommendation and click **Approve decision**. Other options remain visible for comparison, but cannot receive the recommendation's action plan by mistake. Request changes and obtain a revised recommendation before approving another choice. The confirmation identifies the owner and reviewed revision and asks the owner to review proposed owners/dates. The server verifies the actor, current revision, state and recommended option. It records the exact approved revision, actor, time and confirmation rationale. Unassigned action owners and dates remain unset; proposed commitments are not silently accepted for other people.
8. Restart the service and use `@DRII open <decision-id>` to retrieve the persisted card in the allowlisted channel. `@DRII status <decision-id>` refreshes an existing receipt. Use `@DRII resume <decision-id>` after a recoverable failure. Retried/stale clicks cannot replace an approved decision. Start a new review to reconsider an approved choice.

After saving an approval, DRII indexes a bounded summary as a `DECISION` source for future RAG. It labels the human choice, unverified conditions, proposed actions and any synthetic evidence. The immutable decision retains the complete record. If embeddings or source storage fail, the approval still succeeds and the UI reports context indexing pending. Reopen the approved decision to retry indexing. A failed Slack card refresh similarly reports the saved decision ID instead of claiming approval failed.

Unknown speaker identities remain unknown until explicitly mapped; their priorities remain in the shared decision record. Every extracted constraint/preference becomes a quoted, sourced criterion assessed for every option, with no invented weights or aggregate score. Transcript corrections invalidate the previous extraction even if processing is interrupted. No model output can directly approve or send a follow-up. Documents and transcripts are untrusted data; runtime validation rejects unknown IDs and inexact citation quotes. Semantic quality still requires real model evaluations.

## Room capture and proactive review

For the integrated product, set `DRII_ROOM_ENABLED=1` and start the normal app. Open `http://127.0.0.1:3180`. Room and Slack share one writer process. **Do not run a second app/room process against the same decisions.** `npm run dev:room` is a standalone development option when the Slack app is stopped.

Start the microphone explicitly. The page sends short WebM chunks to the configured OpenAI transcription endpoint, then submits only finalized segments. The interface shows capture state, inspectable transcript, a 30-second minimum review interval, measured review latency, mute and dismiss controls. It performs no spoken output. Stop capture or close the page to release microphone tracks. The recorded-MP3/pasted-transcript path remains available if browser audio fails. Chunked capture is buffered; no continuous realtime latency is promised.

Room results provide `@DRII open <decision-id>` for opening the same persisted decision in the allowlisted Slack channel. Approval remains in Slack. Duplicate finalized segments, stopped capture, unchanged conditions, muted suggestions and dismissed evidence are handled explicitly. Loopback host/origin and a page token protect local mutation routes; this is a local room interface, not an internet deployment.

A manual review after the 30-second cooldown refreshes evidence even without new speech. Changed source revisions and recommendation conditions can produce a new objection. A previously approved decision remains immutable. Startup and shutdown close acquired room/Slack/database resources, including when a later connection fails.

Page refresh reads back the saved transcript and latest saved review without making a model call. A temporary read failure retains the session reference for retry. Starting a new session clears the prior review and evidence from the page.

For an offline rehearsal, run `npm run demo:room`. It disables transcription and labels the model and source adapters as scripted. These adapters are imported only by tests/rehearsal commands.

Capture pauses when its upload buffer reaches three chunks. Failed audio remains in browser memory with an explicit **Retry buffered audio** button; keep the page open until it is saved. Finalized transcript requests reuse their segment ID on connection retries. Automatic reviews display elapsed time from the finalized audio chunk through transcription and review; manual reviews display server review time. Neither measurement includes the earlier eight-second recording window. Actual microphone/provider latency remains a live acceptance check.

## Assumption outcomes

An approved card offers **Review now**, **Toggle mute**, and **Dismiss update**. The monitor reads the latest eligible measurement in scoped current source metrics, records timestamped snapshots with source/condition/value/unit, retains UNKNOWN for missing metrics or changed units, and writes a separate REVIEW_NEEDED record for a changed violation or superseded nonmetric source. Older values cannot hide a later violation. Unchanged conditions do not create repeated alerts. Only the owner can mute/dismiss, and approved decision events are never rewritten.

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
