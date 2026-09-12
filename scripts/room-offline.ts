import { readFile } from "node:fs/promises";
import { createRoomServer } from "../src/room/server.js";
import { RoomSessions } from "../src/room/session.js";
import { DecisionEngine } from "../src/intelligence/engine.js";
import { DurableDecisionWorkflow } from "../src/intelligence/workflow.js";
import {
  DemoSources,
  MemoryRecords,
  MemoryDecisions,
  ScriptedModel,
} from "../tests/simulation.js";
const records = new MemoryRecords();
const sources = new DemoSources();
const sessions = new RoomSessions(
  records,
  new DurableDecisionWorkflow(
    new MemoryDecisions(records),
    sources,
    new DecisionEngine(new ScriptedModel(), sources),
  ),
  "demo-workspace",
  "launch",
  {
    actorId: "demo-maya",
    displayName: "Maya (synthetic demo)",
    role: "Product",
  },
);
const html = (
  await readFile(new URL("../src/room/room.html", import.meta.url), "utf8")
)
  .replace('<html lang="en">', '<html lang="en" data-offline="true">')
  .replace(
    "Human approval stays in Slack",
    "SCRIPTED OFFLINE · no live accounts",
  )
  .replace(
    "<h1>Hear the discussion.",
    "<h1>Offline rehearsal.<br>Hear the discussion.",
  )
  .replace("Start microphone", "Microphone unavailable in offline mode")
  .replace('id="start" class="primary"', 'id="start" class="primary" disabled');
const server = createRoomServer(
  sessions,
  async () => {
    throw new Error("Offline room cannot transcribe microphone audio.");
  },
  html,
);
server.listen(3180, "127.0.0.1", () =>
  process.stdout.write(
    "SCRIPTED OFFLINE room at http://127.0.0.1:3180. Transcript fallback only; no external calls.\n",
  ),
);
process.once("SIGINT", () => server.close());
process.once("SIGTERM", () => server.close());
