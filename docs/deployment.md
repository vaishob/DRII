# Demo deployment runbook

## Current boundary

The current integrated instructions are in the [workflow runbook](workflow.md). The selected profile is one Node.js 24 process on the demo laptop, Slack Socket Mode, ClickHouse Cloud, and OpenAI APIs. Live reasoning, durable sessions, follow-up and approval are connected when `DRII_ANALYSIS_MODE=live`; account verification remains pending. The data setup commands below also apply to this profile. The original handoff notes further below describe the earlier implementation stage and are superseded by the current runbook.

## Clean start

Install Node.js 24 LTS and Git. From the repository root:

```powershell
node --version
npm ci
npm run verify
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Copy the environment example only if `.env` does not already exist. On the original development workspace, a checksum-verified portable Node runtime is available at `.tools/node-v24.21.0-win-x64`; for that PowerShell session use `$env:Path = "$PWD\.tools\node-v24.21.0-win-x64;$env:Path"`. `.tools` is ignored and is not part of the project distribution.

Fill these local `.env` values using the intended demo accounts. Before seeding for Slack integration, set `DRII_DEMO_WORKSPACE_ID` to the real Slack team ID and `DRII_DEMO_PROJECT_ID` to the project used by the decision workflow. The default `demo-workspace` / `launch` scope is for standalone CLI use. Seeds, source views and queries use the same configured scope; changing it creates separate scoped records without rewriting the original fixture files.

| Setting                                                       | Purpose                                                                                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `CLICKHOUSE_URL`                                              | HTTPS origin from the Cloud Connect panel, normally port 8443; no username, password, database path or query in the URL |
| `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`                      | ClickHouse credentials with permission to create the chosen database/tables and read/write demo data                    |
| `CLICKHOUSE_DATABASE`                                         | Isolated demo database; default `drii`                                                                                  |
| `CLICKHOUSE_TIMEOUT_MS`                                       | Bounded database request timeout; default 10000 ms                                                                      |
| `OPENAI_API_KEY`                                              | Server-side key from the team's intended OpenAI project                                                                 |
| `OPENAI_BASE_URL`                                             | Configurable inference endpoint, default `https://api.openai.com/v1`; all OpenAI adapters should use this configuration |
| `DRII_TEXT_MODEL`, `DRII_TRANSCRIPTION_MODEL`                 | Selected defaults are `gpt-4.1-2025-04-14` and `gpt-4o-transcribe-diarize`; Alan/Tolga own their adapters               |
| `DRII_EMBEDDING_MODEL`                                        | `text-embedding-3-small`, explicitly 1536 dimensions in ingestion and retrieval                                         |
| `DRII_MIN_RELEVANCE`                                          | Initial cosine similarity threshold, default 0.3; calibrate with live retrieval evaluations                             |
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_DEMO_CHANNEL_ID` | Supplied by Tolga for the eventual Socket Mode integration                                                              |
| `DRII_LIVE_TESTS`                                             | Default 0; set 1 only for intentional live integration runs                                                             |

Never commit `.env`. Do not put keys in Slack cards, issues, fixtures, or logs. These data commands use ClickHouse and OpenAI directly. They do not assume sponsor-kit scripts such as `dev:slack`, CopilotKit managed Channels, Exa, or Ambiguous AI are installed in this repository.

```powershell
npm run db:setup
npm run db:health
npm run db:seed
npm run db:seed
npm run demo:query -- "Are the blocking billing bugs fixed?"
npm run source:show -- engineering-readiness
npm run source:show -- support-capacity
```

Seeding performs live embedding calls on the first run. The second identical seed should make no new embedding calls and should preserve 10 versioned records / 9 logical sources, including one inaccessible fixture. A transient failure can leave a partial seed; rerun to finish. A seeded meeting and approved decisions are durable ClickHouse records, not local JSON state. The seed does not create an approved decision.

To demonstrate a later piece of evidence:

```powershell
npm run demo:query -- "How many support agents can cover a pilot on Friday?"
npm run demo:add-reply
npm run demo:query:after -- "How many support agents can cover a pilot on Friday?"
npm run source:show -- support-follow-up
```

`demo:add-reply` is an explicitly synthetic fixture insertion, not a real participant reply. The complete Slack demo must collect an actual attributed response through Tolga/Alan's workflow. Initial queries use 08:00 UTC on 2026-09-12; after-reply queries use 08:11 UTC. Historical initial queries still exclude the later source after ingestion. Source inspection prints permitted content intentionally; operational logs redact credentials and content.

## Verification and handoff

After schema setup, set `DRII_LIVE_TESTS=1` in `.env`, then run:

```powershell
npm run test:integration
```

The integration suite appends isolated synthetic workspaces. It tests approved-event reconnect recovery, duplicates, out-of-order events, actual ClickHouse SQL ranking with deterministic test vectors, historical sources, scope exclusion, and new evidence. A separate OpenAI test makes a real embedding request when the key exists. Neither is a substitute for running the real seeded retrieval queries or the complete Slack loop. Restore `DRII_LIVE_TESTS=0` afterward. Integration workspaces are retained for inspection; the tests do not delete shared data.

Record the `elapsedMs` from actual seed/query logs, corpus size, model, endpoint profile, and failures in the verification record. Ask a second teammate to run the clean-start steps. Then connect the following boundaries:

1. Tolga normalizes audio/transcripts to `MeetingSchema` and passes the decision-owner identity explicitly.
2. Alan injects `ClickHouseDecisionStore` and `ClickHouseEvidenceRetriever` into the reasoning workflow. Use the exported `decisionQueue` around the complete per-decision read/validate/write operation.
3. Tolga renders returned excerpts and source metadata, correlates attributed replies by question ID, and invokes Alan's owner/revision-checked approval boundary.
4. Verify the approved snapshot and its evidence after process restart. Repeated/stale buttons must not change it.

Run only one app process with this concurrency model. ClickHouse has no transactional compare-and-swap in this adapter. The in-process queue and stable persisted deduplication IDs support the selected demo; multiple independent writers are not supported.

## Failure handling

Missing/placeholder `CLICKHOUSE_URL` produces a configuration message before a request. Connection, authentication, permissions, and request timeouts produce a sanitized ClickHouse error. Missing OpenAI configuration is explicit; embedding failures have a separate error code. Fix persistent configuration problems before retrying. Database failures must not be represented as unsupported claims or empty evidence.

The data layer bounds source size, query length, request time, vector batch size, and result count. The workflow still needs bounded retries and user-visible recoverable FAILED states. `npm run dev` validates Slack credentials and starts the labeled fixture intake; without credentials it exits with sanitized configuration field names. `npm run demo:offline` exercises intake, duplicate suppression and the evidence button without network calls.

## Other deployment profiles and data flows

A self-hosted ClickHouse HTTP(S) origin can replace `CLICKHOUSE_URL` with the same schema/client commands. This secondary profile is documented only and has not been tested here. Docker is not installed on the original development machine. Do not substitute the public ClickHouse playground for a writable private database.

| Data                                       | Intended flow / storage                                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Original audio                             | Slack file storage; temporary laptop processing copy; Tolga owns deletion after transcription              |
| Transcript and decision state              | Laptop orchestrator and durable ClickHouse records                                                         |
| Permitted document chunks and search query | Sent to the configured OpenAI embedding endpoint; resulting vectors stored in ClickHouse                   |
| Retrieved excerpts and claims              | Sent by Alan's reasoning adapter to configured OpenAI inference; summaries and citations returned to Slack |
| Approval and actions                       | Validated owner/revision event, stored in ClickHouse; Slack reflects that result                           |
| Operational logs                           | Laptop logs with Pino redaction; never log whole model prompts/responses or source payloads                |

Local ClickHouse does not make cloud inference or Slack local. Any regulated deployment needs customer-specific decisions about each data flow; database placement provides no compliance guarantee.

The runtime dependencies are the official `@clickhouse/client`, official `openai` SDK, Zod, and Pino. Vitest, TypeScript, ESLint, Prettier and tsx support development. The committed lockfile pins exact versions. No additional vector database or agent framework is used.
