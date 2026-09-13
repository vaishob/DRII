# Hosted room demo

The public demo is **https://drii-demo.vercel.app**. Open it directly for every presentation; there is no installation or server-start step for viewers.

Click **Load sample transcript**, **Add finalized text**, then **Review current discussion**. The prepared launch scenario reports a contradicted claim about blocking bugs. Expand **Inspect exact evidence and provenance** to inspect the synthetic sources. Refresh to restore the same transcript and decision, or click **New session** to clear the visible presentation state.

The static page bundles the existing `RoomSessions`, `DecisionEngine`, and `DurableDecisionWorkflow` with the explicitly scripted fixture adapters. It demonstrates the room UI and sourced review; it does not provide general AI analysis or the live Slack follow-up/approval flow. Microphone capture is disabled. Records stay in the visitor's browser local storage, with schema validation on read. Different browser profiles have separate records. A new session does not delete earlier browser records; clearing site data deletes them.

## Local setup and preview

Use Node.js 24. Install once after cloning, and again when `package-lock.json` changes:

```powershell
npm.cmd ci
```

For each local preview, run:

```powershell
npm.cmd run demo:hosted
```

Open `http://127.0.0.1:4173`; keep the terminal running and stop it with `Ctrl+C` afterward. This serves the same built files and response headers as the public demo. See the README's Windows setup if Node is installed only under `.tools`.

## Redeploy after changes

The Vercel project is `drii-demo` in `anandvaishob-9242s-projects`. Deployment is manual; pushing Git does not automatically redeploy this page. The long-running Slack app remains a separate runtime.

One-time Vercel CLI setup, after signing into the account that owns the project:

```powershell
npm.cmd install --prefix .tools/vercel --no-audit --no-fund vercel@59.16.0
& '.\.tools\vercel\node_modules\.bin\vercel.cmd' login
```

Build and verify whenever publishing changed code:

```powershell
npm.cmd run verify
```

Link the generated folder once per checkout (repeat if `demo-dist/.vercel` is removed):

```powershell
& '.\.tools\vercel\node_modules\.bin\vercel.cmd' link --cwd demo-dist --project drii-demo --scope anandvaishob-9242s-projects --yes
```

Inspect the upload and then deploy:

```powershell
& '.\.tools\vercel\node_modules\.bin\vercel.cmd' deploy --cwd demo-dist --project drii-demo --scope anandvaishob-9242s-projects --dry --json
& '.\.tools\vercel\node_modules\.bin\vercel.cmd' deploy --cwd demo-dist --project drii-demo --scope anandvaishob-9242s-projects --prod --yes
```

The dry run must list only `index.html`, `demo.js`, and `vercel.json`. The generated directory is the deployment root; never deploy the repository root for this static demo. Vercel link metadata and any generated environment files are ignored. The build rejects server SDK dependencies, and the page's content policy blocks network API connections. It needs no application environment variables.

If the Windows CLI reports successful login but a subsequent `whoami` is logged out, set `$env:VERCEL_TOKEN_STORAGE = 'file'` before login and subsequent CLI commands. This uses Vercel's supported credential file storage outside the repository.

After deployment, open the public alias in a fresh browser and repeat the sample/review/evidence/refresh flow. `npm run verify` checks types, all unit tests, lint, formatting, production build, and the static build; the browser check verifies the bundled workflow and browser storage.
