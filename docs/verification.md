# Verification record â€” 2026-09-12

## Implemented and checked offline

Environment: Windows PowerShell, portable official Node.js 24.21.0. Dependencies are pinned in `package-lock.json`.

`npm run verify` passed TypeScript typecheck, 31 Vitest tests across six files, ESLint, Prettier check, and production build. The latest pre-handoff Vitest run took 4.45 seconds; this is an offline test-run duration, not product latency. Tests cover versioned contract examples, malformed/cross-scope records, approval snapshot revisions, duplicate/conflicting events, queue failure recovery, actual local HTTP timeouts and sanitized errors, source ingestion retries, exact chunk content, structured metric parameters, restricted-source embedding exclusion, retrieval failure distinctions, changing results, and mocked OpenAI request/response handling.

The fixture contains 10 versioned records, 9 logical sources, 8 visible sources, one restricted source, and a separate later reply. These counts describe files prepared for seeding, not a verified live database corpus. Runtime modules never import the separate evaluation expectations.

## Required live and team gates still open

No root `.env` with ClickHouse/OpenAI credentials was available during implementation. Live SQL schema execution, database durability, actual embedding access, relevance calibration, and live latency have not been verified. The opt-in integration tests are implemented but are not recorded as passing live tests.

| Gate                                       | Status / evidence needed                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Clean install from lockfile                | Passed: `npm ci`, post-install `npm run verify`, scaffold startup, and expected missing-config health error |
| ClickHouse schema and seed twice           | Pending endpoint/credentials; record logical counts and any errors                                          |
| Real-model seeded retrieval                | Pending credentials; run held-out queries and record results and elapsedMs                                  |
| Approved snapshot survives reconnect       | Real ClickHouse integration test pending                                                                    |
| Source views and restricted exclusion      | Offline boundary tests pass; live `source:show`/query checks pending                                        |
| Shared payload agreement                   | Examples and interfaces ready for Tolga/Alan review                                                         |
| Slack/audio/intelligence complete loop     | Other workstreams not yet present on main at last pull                                                      |
| Clean-start rehearsal by a second teammate | Pending integrated application and accounts                                                                 |
| Stretch #14                                | Deferred until #12 passes, as required by the issue                                                         |

## Local review sequence

The work uses stacked issue-specific branches: `feat/1-contracts-storage` â†’ `feat/2-demo-data` â†’ `feat/5-evidence-retrieval` â†’ `feat/10-demo-runbook`. Review each against its predecessor to keep the diff focused, or compare the final branch with main for the complete data foundation. Feature branches have not been pushed and issues have not been closed. The README's push-approval rule still applies.

#1 is implemented locally but still needs shared interface agreement and live persistence verification. #2/#5 have source ingestion, retrieval, fixtures and commands but still need real seed/retrieval evidence. #10 has the runbook and offline startup checks; the fully tested selected deployment and second-person rehearsal remain open. These limitations prevent claiming a finished working MVP.
