# DRII — Deep Research Intern Intelligence

DRII turns fragmented organizational context into evidence-backed decisions. It reviews a meeting, retrieves company evidence, challenges unsupported assumptions, asks a missing stakeholder, and records a human-approved decision in Slack.

**Status:** hackathon implementation plan. The stack below is selected; application code, credentials, deployment, and live integrations still need to be implemented and verified. Issue descriptions contain acceptance criteria, not claims of completed features.

## Demo and MVP scope

1. Upload a prepared 60–90-second MP3 to the public `#drii-demo` Slack channel.
2. Reply in its thread with `@DRII analyze this meeting`.
3. DRII transcribes the recording and extracts the decision, options, priorities, and claims.
4. It retrieves evidence from ClickHouse and publishes a Decision X-Ray with sources and a red-team objection.
5. A participant confirms a targeted follow-up question; a teammate answers it in the thread.
6. DRII updates the recommendation, explaining what changed. The decision owner approves an option.
7. The decision, evidence, ordered actions, assumptions, and approval revision remain retrievable.

A pasted transcript is the explicit transcription fallback. Synthetic company records are labeled as demo data. No separate upload website is required. Live microphone input, spoken interruptions, dedicated hardware, and later outcome monitoring are stretch work.

## Selected technology stack

| Area | Decision | Purpose |
| --- | --- | --- |
| Runtime and language | Node.js 24 LTS, TypeScript in strict mode, ES modules | One shared backend and shared types across all three workstreams |
| Packages | npm with a committed `package-lock.json` | Reproducible dependency versions, established in #1 |
| Slack | `@slack/bolt`, Socket Mode, Block Kit | Events, threaded cards, buttons, and forms; no public inbound endpoint needed for the demo |
| AI SDK and text analysis | Official `openai` Node SDK; Responses API; `gpt-4.1-2025-04-14` | Extraction, evidence assessment, follow-up reasoning, and a separate red-team call using one pinned text model |
| Speech-to-text | `gpt-4o-transcribe-diarize` through Audio Transcriptions | Speaker-labeled segments from the prepared meeting |
| Embeddings | `text-embedding-3-small`, explicitly 1536 dimensions | The same embedding model/dimensions for documents and queries |
| Storage and retrieval | ClickHouse Cloud, `@clickhouse/client`, SQL cosine-distance search over `Array(Float32)` vectors | Documents, metrics, embeddings, transcripts, decision events, and source provenance |
| Contracts and validation | `zod`, shared schemas in `src/contracts/` | Validate model output and module boundaries |
| Workflow | Explicit TypeScript orchestrator with bounded tool calls | Resumable steps without an additional agent framework |
| Logging | `pino` with credential/content redaction | Structured operational errors and timings |
| Tests and code checks | `vitest`, TypeScript typecheck, ESLint, Prettier | Unit/contract tests plus separate opt-in integration/evaluation runs |
| Demo deployment | One long-running Node process on the demo laptop, connected to ClickHouse Cloud and OpenAI | A concrete first deployment; cloud-hosted app/container packaging can follow |

The text model is chosen for a fixed, tool-capable Structured Outputs interface, not as a claim that it is the newest or best model. Account access, billing, and rate limits must be verified before the rehearsal. Model IDs are configurable, but changing them requires re-running the evaluation fixtures.

Use `diarized_json` and `chunking_strategy: "auto"` for the meeting transcription. Speaker labels are not employee identities: map them explicitly or retain unknown identities. Start with MP3 and a conservative application upload limit of 20 MB, implemented as a named configuration value. The prerecorded transcription model is not the live-room transport for #13.

Use exact cosine-distance ranking for the small demo corpus; an approximate vector index is not a prerequisite. Filter workspace, project, visibility, and time before selecting sources. Keep metric checks parameterized. All durable application records live in ClickHouse; original audio stays in Slack with temporary processing copies, rather than audio blobs in the database.

Official references: [Node releases](https://nodejs.org/en/about/previous-releases), [Slack Bolt and Socket Mode](https://docs.slack.dev/tools/bolt-js/creating-an-app/), [GPT-4.1](https://developers.openai.com/api/docs/models/gpt-4.1), [file transcription](https://developers.openai.com/api/docs/guides/speech-to-text), [embeddings](https://developers.openai.com/api/docs/guides/embeddings), [ClickHouse Node client](https://clickhouse.com/docs/integrations/language-clients/js/index), and [Vitest](https://vitest.dev/guide/).

## Architecture and ownership

```text
Slack audio / transcript / participant reply
                    |
       Tolga: Slack + transcription adapter
                    |
       Alan: decision workflow + AI analysis
                    |
       Vaishob: evidence retrieval + ClickHouse
                    |
       Alan: findings + recommendation
                    |
       Tolga: cards + follow-up + approval
                    |
       Vaishob: persisted decision events
```

These are modules in one process, not three deployed microservices. Dependency injection allows local fixture adapters while teammates implement the real boundaries. The decision workflow accepts normalized data, not Slack SDK objects, so a later meeting plugin can reuse it.

Planned layout (created by the implementation issues):

```text
src/
  contracts/    # Vaishob establishes; all three agree the interface examples
  slack/        # Tolga: events, cards, buttons, reply correlation
  audio/        # Tolga: file retrieval and transcription adapter
  intelligence/ # Alan: extraction, checking, red-team, follow-up, orchestration
  data/         # Vaishob: ClickHouse persistence, retrieval, seeding
  config/       # Vaishob: validated configuration; each owner supplies their fields
  index.ts      # Vaishob bootstraps; Tolga coordinates final integration
fixtures/       # Vaishob owns input data; expected reasoning results stay separate
tests/          # Each owner tests their module; Alan owns reasoning evaluations
```

### Shared contracts to publish first in #1

| Boundary | Owner | Required behavior |
| --- | --- | --- |
| `transcribeMeeting(audio)` | Tolga | Return transcript segments with stable IDs, text, nullable speaker identity, and timestamps |
| `analyzeDecision(meeting)` | Alan | Return or resume a decision revision with options, criteria, claims, findings, and next question |
| `retrieveEvidence(query, scope)` | Vaishob | Return permitted source IDs, excerpts/metrics, timestamps, and relevance metadata |
| `challengeDecision(decisionId, expectedRevision)` | Alan | Produce an additional sourced objection and a new review revision |
| `resumeWithEvidence(decisionId, questionId, answer)` | Alan | Incorporate an attributed reply and explain changed findings |
| `getDecision(decisionId)` / `appendDecisionEvent(event)` | Vaishob | Read the latest logical state and persist uniquely identified events |
| `approveDecision(decisionId, expectedRevision, actor, option)` | Alan with Vaishob's persistence | Validate the owner and revision, then record approval; Tolga invokes it from Slack |

Use a versioned shared payload containing `workspaceId`, `meetingId`, `decisionId`, `revision`, and stable claim/evidence/question IDs. Keep `channelId` and `threadTs` as transport context; preserve Slack timestamps as strings. Evidence includes exact source content and its date. A follow-up is tied to both the decision and question, not just the latest channel message.

States: `RECEIVED → ANALYZING → NEEDS_INPUT / READY_FOR_REVIEW → APPROVED`, with recoverable `FAILED`. Claims use `SUPPORTED`, `CONTRADICTED`, or `INSUFFICIENT_EVIDENCE`. Missing search results do not prove a claim false. Keep competing priorities visible; any weights require human confirmation.

ClickHouse persistence uses append-only events and an explicit latest-revision query. A single-process, per-decision work queue serializes changes. Persist deduplication IDs and test restart recovery; do not assume database row uniqueness, transactional compare-and-swap, or exactly-once Slack delivery. Log short explanations and source references, not hidden model reasoning.

## Work order for each teammate

Everyone has four MVP tickets totaling **15 relative effort points**, plus one separate **5-point stretch** ticket. Points are estimates of complexity, not hours. P0 is the core path; P1 is required verification/submission work; P2 starts after the complete MVP passes.

| Member | Work order | First handoff |
| --- | --- | --- |
| **Tolga — @tolgabippus** | [#3](https://github.com/vaishob/DRII/issues/3) transcript input → [#8](https://github.com/vaishob/DRII/issues/8) fixture card → finish #3 audio → finish #8 real analysis → [#9](https://github.com/vaishob/DRII/issues/9) follow-up/approval → [#12](https://github.com/vaishob/DRII/issues/12) rehearsal → stretch [#13](https://github.com/vaishob/DRII/issues/13) | A mention returns a card in the correct thread; then a normalized real transcript |
| **Vaishob — @vaishob** | [#1](https://github.com/vaishob/DRII/issues/1) contracts/scaffold/storage → [#2](https://github.com/vaishob/DRII/issues/2) seed data → [#5](https://github.com/vaishob/DRII/issues/5) retrieval → [#10](https://github.com/vaishob/DRII/issues/10) reproducible deployment → stretch [#14](https://github.com/vaishob/DRII/issues/14) | Contracts and examples first; then one query returns a traceable source |
| **Alan — @alanlim0** | [#4](https://github.com/vaishob/DRII/issues/4) extraction → [#6](https://github.com/vaishob/DRII/issues/6) evidence check/red-team → [#7](https://github.com/vaishob/DRII/issues/7) follow-up/recommendation → [#11](https://github.com/vaishob/DRII/issues/11) evaluation → stretch [#15](https://github.com/vaishob/DRII/issues/15) | Structured extraction from an agreed transcript; then a source-backed contradiction |

### Team integration checkpoints

1. **Contracts first:** agree example payloads in #1 immediately. Tolga and Alan start with those examples while Vaishob completes storage. No one waits for the entire database implementation.
2. **Visible first slice:** Tolga demonstrates transcript-to-fixture-card; Alan demonstrates extraction; Vaishob demonstrates seeded evidence retrieval. Mark fixture responses visibly.
3. **Grounded slice:** replace fixture cards with actual analysis and ClickHouse sources. Run this integration before starting optional features.
4. **Complete loop:** add the real participant reply, changed recommendation, owner approval, and persisted record. Test these together as #9 progresses.
5. **Submission gate:** finish #10, #11, and #12. A second teammate runs the documented demo; record actual failures, timings, and limitations.
6. **Stretch only:** #13 can start interface work after #12. #14 supplies changed metric snapshots to #15; proactive room objections connect #13 and #15 afterward.

Issue dependencies describe integration gates, not a requirement to wait before writing a module against agreed fixtures. Write relevant tests during every issue; #11 and #12 consolidate evidence and rehearsal rather than postponing all testing.

## Slack and account setup

Tolga creates/installs one internal Slack app, enables Socket Mode and interactivity, and invites the bot to the configured public demo channel. Start with bot scopes `app_mentions:read`, `chat:write`, `channels:history`, and `files:read`, and app-token scope `connections:write`. Subscribe to `app_mention` and `message.channels` for correlated follow-up replies. Recheck the manifest against the implemented calls before installation.

For a mention beneath an upload, resolve the root message from its known timestamp using permitted channel history, check the returned timestamp, and retrieve its file metadata. Receive subsequent replies through events rather than polling whole thread histories. [Channel history access](https://docs.slack.dev/reference/methods/conversations.history/) and [channel message events](https://docs.slack.dev/reference/events/message.channels/) document these boundaries.

Alan verifies text-model access and schema parsing; Tolga verifies transcription access; Vaishob verifies embeddings and ClickHouse connectivity. This planning change does not create accounts, buy credits, or run paid API calls.

Configuration names to implement in #1, with placeholders in a future `.env.example`:

| Configuration | Supplied by |
| --- | --- |
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_DEMO_CHANNEL_ID` | Tolga |
| `OPENAI_API_KEY` | Team's OpenAI project, available locally to the service |
| `DRII_TEXT_MODEL`, `DRII_TRANSCRIPTION_MODEL`, `DRII_EMBEDDING_MODEL` | Defaults from the selected stack |
| `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_DATABASE` | Vaishob |

Documenting configuration names does not imply credentials have been configured. Keep secrets out of issues, commits, transcripts, and logs. The complete local setup and actual npm scripts are a deliverable of #1/#10; no runnable setup commands are claimed at this stage.

## Testing and demo acceptance

Use Vitest for deterministic unit and contract tests with fake Slack/STT/model clients. Use separate opt-in integration tests for real ClickHouse/OpenAI/Slack access; clearly identify which were actually run. #1 creates `dev`, `build`, `typecheck`, `test`, `lint`, and `format:check` npm scripts plus the lockfile.

Before presentation, verify:

- An MP3 and its transcript both enter the same analysis contract.
- Duplicate events do not produce duplicate logical decisions; bot messages do not cause loops.
- Evidence links resolve; unknown and stale evidence stay explicit; source changes change relevant findings.
- The red-team step retrieves supporting evidence instead of relying on a fixed demo answer.
- A reply maps to the correct question/thread; an unrelated reply is ignored.
- Only the configured owner can approve the current revision; repeated/stale clicks do not overwrite a decision.
- Provider failure produces an actionable status; the approved record survives restart.
- Real processing time is measured. The prepared transcript/backup recording is labeled honestly if used.

| Judging criterion | Proof in the demo |
| --- | --- |
| Core Requirements & Functionality | Audio in Slack completes the loop through a persisted human approval |
| Innovation & Theme Alignment | A sourced objection and missing participant's reply change the shared decision |
| Technical Execution & Integration | ClickHouse-backed retrieval, validated outputs, traceable evidence, recovery tests |
| Usefulness & Agentic Experience | Inspectable findings, meaningful follow-up, human control, ordered actions |

## Deployment boundary and collaboration

The MVP uses cloud data/inference and Slack. Self-hosted ClickHouse is a later selectable database endpoint, not proof of a fully on-prem product. A regulated deployment also needs a decision about audio, model/embedding inference, logs, and the communication channel. No compliance certification is implied.

Create issue-specific feature branches and reviewed PRs. Use English Conventional Commits. Do not push directly to `main` or `master`; follow the team's push-approval rule. Keep TypeScript strict, avoid `any` and production `console.log`, use named constants, and preserve other teammates' changes. Vaishob coordinates shared contracts/configuration; each owner keeps implementation in their module to reduce merge conflicts.
