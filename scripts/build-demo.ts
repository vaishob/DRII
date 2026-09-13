import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = new URL("../", import.meta.url);
const output = new URL("demo-dist/", root);
await mkdir(output, { recursive: true });
const bundle = await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: ["demo/browser.ts"],
  outfile: fileURLToPath(new URL("demo.js", output)),
  bundle: true,
  platform: "browser",
  target: ["es2022"],
  format: "iife",
  minify: true,
  metafile: true,
  alias: { "node:crypto": fileURLToPath(new URL("demo/crypto.ts", root)) },
});
// A new transitive import must never silently ship server providers or keys.
const forbidden = Object.keys(bundle.metafile.inputs).filter((path) =>
  /node_modules\/(?:openai|@slack|@clickhouse|pino)\//.test(
    path.replaceAll("\\", "/"),
  ),
);
if (forbidden.length)
  throw new Error("Demo bundle includes an unexpected backend dependency.");

let html = await readFile(new URL("src/room/room.html", root), "utf8");
const apiStart = html.indexOf("      async function api(path, value) {");
const apiEnd = html.indexOf("      function render() {", apiStart);
if (apiStart < 0 || apiEnd < 0)
  throw new Error("Room API template changed; update the static demo bridge.");
html =
  html.slice(0, apiStart) +
  "      async function api(path, value) { return window.driiDemoApi(path, value); }\n" +
  html.slice(apiEnd);

function replace(before: string, after: string): void {
  if (!html.includes(before))
    throw new Error("Room template changed; update the hosted demo text.");
  html = html.replace(before, after);
}
replace('<html lang="en">', '<html lang="en" data-offline="true">');
replace("<head>", '<head>\n    <link rel="icon" href="data:," />');
replace("Human approval stays in Slack", "SCRIPTED DEMO · synthetic evidence");
replace(
  "<h2>You control the microphone</h2>",
  "<h2>Try a meeting transcript</h2>",
);
replace(
  "Capture a meeting with explicit start and stop controls. DRII reviews\n        finalized transcript segments against company evidence and surfaces\n        questions worth asking.",
  "Try a scripted launch review: add the sample transcript, review the\n        discussion, then inspect the contradictory company evidence. This public\n        demo uses synthetic records and makes no model or Slack calls.",
);
replace(
  "When you start, audio is sent in short chunks to the configured\n            OpenAI transcription service. Confirm that participants are ready.\n            Speaker identities stay unknown until corrected. No spoken output is\n            played.",
  "Your transcript and review stay in this browser. Start with the sample\n            below to see the prepared launch scenario. Microphone capture, live\n            AI analysis, and Slack approval require the separately configured app.",
);
replace("Start microphone", "Microphone unavailable in demo");
replace('id="start" class="primary"', 'id="start" class="primary" disabled');
replace(
  '<label for="manual">Transcript fallback</label',
  '<label for="manual">Meeting transcript</label',
);
replace(
  '          <p id="error" class="error" role="alert"></p>',
  '          <button id="sample" style="margin-top: 10px">Load sample transcript</button>\n          <p id="error" class="error" role="alert"></p>',
);
replace(
  "Only finalized chunks enter a review. Reviews are limited to one per\n            30 seconds. Chunked capture is buffered, not continuous realtime\n            inference.",
  "Click Load sample transcript, Add finalized text, then Review current\n            discussion. The launch scenario is scripted, so other text will not\n            receive general AI analysis. Reviews are limited to one per 30 seconds.",
);
replace(
  "Recordings and pasted transcripts are inputs, never approval.\n        Source-backed findings may still be uncertain. Inspect the evidence and\n        let the configured owner make the final choice. If capture fails, stop\n        the microphone and use the transcript fallback.",
  "Public scripted demo · no live accounts. Transcript and review records\n        persist only in this browser’s local storage. Refresh to restore your\n        session; clearing site data removes it. This page cannot send Slack\n        messages or approve a decision.",
);
replace(
  "localStorage.setItem('drii-room', room.id)",
  "localStorage.setItem('drii-hosted-room:v1', room.id)",
);
replace(
  "localStorage.getItem('drii-room')",
  "localStorage.getItem('drii-hosted-room:v1')",
);
replace(
  "'To continue in your configured Slack channel: @DRII open ' +",
  "'Saved in this browser only · demo decision ' +",
);
replace("    <script>", '    <script src="./demo.js"></script>\n    <script>');
replace("      const token = '__ROOM_TOKEN__';\n", "");
await writeFile(new URL("index.html", output), html);
await copyFile(
  new URL("demo/vercel.json", root),
  new URL("vercel.json", output),
);
process.stdout.write(
  "Built standalone scripted room demo in demo-dist/ (no live service calls).\n",
);
