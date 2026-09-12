# Remaining issue implementation

Base: main `988b349` (12 September 2026). Feature branch: `feat/complete-decision-workflow`.

- [ ] #4 / #6: structured extraction, source validation, evidence checks and red-team review.
- [ ] #7: durable resumable workflow, ordered actions, assumptions, owner/revision approval.
- [ ] #3 / #8 / #9: durable Slack intake, live cards, recipient preview, replies and approval.
- [ ] #11 / #12: deterministic and opt-in model evaluations, full-flow demo, submission material.
- [ ] #13 / #14 / #15: live-room capture, measured assumption snapshots, restrained review alerts.
- [ ] #1 / #2 / #5 / #10: integrated schema/seed/durability checks and deployment verification.
- [ ] Final pull, checks, small commits, PR and issue updates.

Live acceptance requires configured ClickHouse, OpenAI and Slack accounts and a second teammate's rehearsal. No live pass is implied by offline test results. PR #17's unmerged workflow skeleton was inspected; this implementation uses the already merged contracts instead of its conflicting scaffold.
