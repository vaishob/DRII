import scenario from "../fixtures/demo/seven-days-later.json" with { type: "json" };
import { loadConfig } from "../src/config/index.js";
import { createDatabase } from "../src/data/database.js";
import { ClickHouseDecisionStore } from "../src/data/decisions.js";
import { ClickHouseSourceStore } from "../src/data/sources.js";
import { OpenAIEmbedder } from "../src/data/embeddings.js";
import { ClickHouseRecords } from "../src/data/records.js";
import { AssumptionMonitor } from "../src/intelligence/monitor.js";

const config = loadConfig();
const id = process.argv[2];
if (!id) throw new Error("Supply an approved synthetic decision ID after --.");
const db = createDatabase(config);
try {
  const store = new ClickHouseDecisionStore(db);
  const d = await store.getDecision(config.DRII_DEMO_WORKSPACE_ID, id);
  if (!d || d.state !== "APPROVED")
    throw new Error(
      "An approved decision in the configured workspace is required.",
    );
  const sources = new ClickHouseSourceStore(db, new OpenAIEmbedder(config));
  const s = await sources.getSource(
    d.workspaceId,
    d.projectId,
    scenario.sourceId,
    scenario.asOf,
  );
  if (!s?.synthetic)
    throw new Error(
      "This command only advances the explicitly synthetic support source.",
    );
  if (!s.content.includes(scenario.label))
    await sources.ingestSource({
      ...s,
      revision: s.revision + 1,
      updatedAt: scenario.asOf,
      availableAt: scenario.asOf,
      title: scenario.label,
      content:
        scenario.label +
        ". One support agent is now available; the approved pilot assumed two.",
      metrics: [{ ...scenario.metric, measuredAt: scenario.asOf }],
    });
  const monitor = new AssumptionMonitor(
    sources,
    new ClickHouseRecords(db),
    () => Date.parse(scenario.asOf),
    scenario.label,
  );
  process.stdout.write(
    scenario.label + "\n" + (await monitor.review(d)) + "\n",
  );
} catch {
  process.stderr.write(
    "Synthetic assumption demo failed. Verify configuration, an approved decision and the seeded support source.\n",
  );
  process.exitCode = 1;
} finally {
  await db.close();
}
