# First Slack slice: setup and handoff

This implementation covers the first usable portions of #3 and #8. It can receive a transcript or one MP3 from Slack, call the configured transcription API, and show an interactive fixture card. It does not yet evaluate the meeting, retrieve company data, ask stakeholders, approve decisions, or persist them across restarts.

## Local verification without accounts

With Node.js 24:

```sh
npm ci
npm run typecheck
npm test
npm run lint
npm run format:check
npm run build
npm run demo:offline
```

The offline demo invokes the real intake controller with a synthetic transcript and fake Slack transport, submits the same event twice, and clicks Show evidence. Its output identifies fixture mode and zero external calls. Unit tests also exercise the real OpenAI SDK through a mocked HTTP transport; they do not send audio to OpenAI.

The optional macOS x64 Rolldown binding is explicitly recorded because npm omitted it during the initial installation on the development machine. Other platforms skip this optional package and use the test runner's own platform dependencies. Do not install with `--omit=optional`; the test runner needs its native binding.

## Connect the real Slack workspace

1. In Slack's app management, create an app **from a manifest**, select the demo workspace, and paste `slack-manifest.json`.
2. Create an app-level token with `connections:write`. This is the `xapp-…` token used by Socket Mode.
3. Install the app into the workspace and obtain the bot's `xoxb-…` token. Workspace policy may require an administrator.
4. Create or choose a public demo channel, invite DRII into it, and copy its channel ID.
5. Create a local `.env` from `.env.example` and enter the bot token, app token, and channel ID. Keep `.env` private. An OpenAI API key is needed only for MP3 transcription; transcript intake works without it.
6. Run `npm run dev`. A successful connection logs fixture mode, temporary storage, and whether audio transcription is configured.

The manifest requests `app_mentions:read`, `chat:write`, `channels:history`, and `files:read`, and subscribes only to `app_mention`. The future follow-up work in #9 adds the relevant message-event subscription. The bot accepts requests only in the configured channel. Socket Mode handles delivery acknowledgments; each button handler calls `ack()` before looking up its details.

## First test: paste a transcript

Post in the configured channel:

```text
@DRII analyze
Sales: We want to launch Monday.
Engineering: Critical bugs remain open.
Product: Could we run a limited beta?
```

Select the actual Slack app mention, not just plain text spelling its name. The bot creates one status message in the same thread and updates it to the card. The card prominently states that the sample decision is **not derived from the submitted meeting**. Show transcript reveals the actual submitted text; Show evidence displays synthetic fixture excerpts privately to the clicking participant.

## Audio demonstration

1. Prepare a 60–90-second MP3. The current audio limit is 20 MB.
2. Upload just that file in one message in the public demo channel.
3. Reply in the upload's thread with `@DRII analyze this meeting`.
4. DRII fetches the exact parent message, downloads its attachment, transcribes it, and updates the status card.
5. Click Show transcript to inspect the returned speaker labels and text. Employee identities remain unverified.

Only MP3 and UTF-8 `.txt` attachments are supported initially. Multiple attachments are rejected so the app cannot silently choose the wrong recording. Text files are bounded to 60,000 bytes and all transcripts to 60,000 characters. Downloads are also bounded while streaming, not just checked against Slack's reported size.

The transcription adapter uses `gpt-4o-transcribe-diarize`, `response_format: diarized_json`, and `chunking_strategy: auto`, following the [official file-transcription guide](https://developers.openai.com/api/docs/guides/speech-to-text). Speaker labels are preserved; diarization is not employee identification.

Missing API access, a download failure, or failed transcription shows a retry/transcript-fallback message. Send a **new** mention to retry a failed request; redelivery of the same Slack event is suppressed. Private external file URLs and redirecting download links are rejected instead of forwarding the bot credential elsewhere.

## Integration handoff

The initial transport boundary is `src/contracts/intake.ts`. The shared durable contract is now in `src/contracts/index.ts`; use `fromIntakeMeeting` from `src/contracts/from-intake.ts` with explicit project/owner/time context to convert it. Unknown timing and speaker identity are preserved. See [shared contracts](contracts.md). The current synchronous `RunStore` remains the temporary Slack session adapter; wiring durable async session state and the real decision workflow is still required.

| Owner   | Boundary                                            | Next action                                                                                                                                            |
| ------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Alan    | `DecisionAnalyzer.analyzeDecision(meeting, signal)` | Replace `fixtureAnalyzer` through dependency injection with the validated real decision workflow. Preserve the abort signal and source-ID consistency. |
| Vaishob | `RunStore` and `Meeting` / `DecisionView`           | Replace the temporary store with persistent events/revisions and durable deduplication; reconcile naming with shared #1 contracts.                     |
| Tolga   | `createSlackApp(config, services)` and `SlackPort`  | Keep transport separate, add actual challenge/follow-up/approval only when their service boundaries are ready.                                         |

`DRII_ANALYSIS_MODE` currently accepts **fixture only**. Selecting `live` fails startup rather than pretending the sample analyzer is real. To integrate a real analyzer, implement/wire the provider and then extend configuration plus tests. The adapter must return only evidence accessible to the demo channel; the UI cannot independently infer source permissions.

The memory store holds at most 50 runs and expires completed/failed runs after one hour. It is process-local and resets on restart. This does not satisfy the final persistent-storage or restart acceptance criteria in #1/#3/#9. The UI states this explicitly. Do not close #3 or #8 solely because the fixture path works.

Known first-slice boundaries:

- Audio download and transcription are implemented, but real account access, file access, and latency need a workspace test.
- The card's decision and evidence are fixed UI fixtures, even when the transcript came from real audio.
- Buttons for evidence and transcript work; red-team, stakeholder questions, and approval are not exposed yet.
- No ClickHouse queries are performed by this first-slice entrypoint.
- The manifest supports an internal demo app; distribution, tenant isolation, and other meeting-platform plugins are later work.

## Manual acceptance after credentials are configured

- Run one pasted transcript and one MP3 in Slack; inspect the original transcript in each result.
- Confirm status/result stay in the source thread and details are visible only to the clicking participant.
- Try an unsupported file, an empty message, and an expired card; verify actionable feedback.
- Confirm a bot mention in another channel does not start processing.
- Test a new mention after an intentional provider failure.
- Record measured transcription latency and the actual account/provider used.

These checks require live credentials and are not implied by passing the offline tests.
