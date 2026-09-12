# Shared integration contracts (version 1.0)

`src/contracts/index.ts` exports runtime Zod schemas and inferred TypeScript types. `src/contracts/services.ts` defines dependency-injected module interfaces. All ten record examples are in `fixtures/contracts/v1/examples.json`. They are synthetic integration examples, not runtime reasoning answers.

The current README selects camelCase payload fields: `schemaVersion`, `workspaceId`, `meetingId`, `decisionId`, `revision`, `sourceIds`, and `createdAt`. Database columns use snake_case. Parse inputs at each external boundary. ISO timestamps retain timezones; Slack `threadTs` stays a string. Speaker labels remain separate from nullable employee identities. IDs must be stable across retries.

`fromIntakeMeeting` in `src/contracts/from-intake.ts` converts the first Slack slice's transport payload (`src/contracts/intake.ts`, numeric version 1) to the shared durable payload (version `1.0`). Supply explicit project/title/owner/time/transport context. The submitter is not automatically made the decision owner. Unknown segment timings and labels remain null; known seconds convert to milliseconds. Only an explicitly supplied identity map can resolve a speaker. The canonical audio size limit re-exports the transport's 20 MB constant.

Alan owns `DecisionWorkflow`, including extraction, follow-up correlation, state transitions, and owner/revision validation. Tolga calls it from normalized Slack/audio adapters. Vaishob owns `DecisionStore`, `SourceStore`, and `EvidenceRetriever`. Storage reads require a workspace ID; retrieval also requires a project and `asOf` timestamp. No Slack SDK types cross these interfaces.

## Decision transitions and approval

`RECEIVED → ANALYZING → NEEDS_INPUT / READY_FOR_REVIEW → APPROVED`.

An attributed answer or a requested challenge starts another analysis/review revision. Any unapproved state can enter recoverable `FAILED`; retry enters `ANALYZING`. An approved decision is immutable in the MVP. Preserve the same decision ID across retries; increment revision for each new logical event. Alan's orchestrator must serialize the complete read/validate/write sequence per workspace and decision within the single process.

An approval event has a new revision, with `approval.approvedRevision` pointing to the immediately preceding review revision. For example, approving review 4 creates event/snapshot revision 5 and records approvedRevision 4. Verify current state is READY_FOR_REVIEW, expectedRevision is 4, actor is the decision owner, and option exists before writing. Schemas validate the snapshot, but cannot by themselves enforce previous-state authorization. Persist the transport's stable deduplication ID and check it before repeating a mutation or emitting side effects.

Every event includes a complete validated snapshot, stable event ID and deduplication ID. Evidence carries exact excerpts, source revision/date/owner/link, metrics, and relevance metadata. Relevance is not truth or confidence. Claims use SUPPORTED, CONTRADICTED, or INSUFFICIENT_EVIDENCE; empty retrieval does not contradict a claim. Retrieved text is untrusted data, including instruction-like content. Never interpret source content as tool instructions.

`ClickHouseDecisionStore` in `src/data/decisions.ts` implements the storage boundary. `decisionQueue.run(workspaceId, decisionId, work)` in `src/data/queue.ts` supplies the shared single-process queue for Alan's workflow. All callers must use that queue around their entire operation. The storage adapter uses a separate internal write queue to avoid nested-lock deadlocks. It rejects changed content under an existing event ID, deduplication ID, or revision and treats an identical retry as a no-op. Delayed older revisions may be appended but cannot replace the latest revision. Direct database writers or multiple app processes bypass these protections and are outside this MVP's concurrency model.

Run `npm run db:setup` to create the database/tables, then `npm run db:health`. This requires a configured endpoint and a user allowed to create the selected database. For live durability verification after setup, set `DRII_LIVE_TESTS=1` in `.env` and run `npm run test:integration`. Tests append synthetic records in a unique integration workspace and do not delete shared data. Without explicit opt-in the live test is skipped; that is not a successful live verification.

`SourceStore.getSource` returns null for absent or inaccessible sources without revealing private metadata. Retrieval returns FOUND, EMPTY, UNAVAILABLE for an explicitly requested inaccessible source, or FAILED for database/embedding failures. The demo only supports shared workspace-visible sources, not production Slack/Jira/CRM permission parity.

## First handoff

Run `npm ci` then `npm run verify` with Node.js 24. Teammates can parse the examples immediately and implement against the service interfaces. Interface agreement and a live end-to-end run remain team integration gates; successful offline tests do not establish live provider access.
