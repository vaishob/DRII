import { checkReadiness } from "../src/diagnostics/readiness.js";
import { createReadinessProbes } from "../src/diagnostics/probes.js";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--live")) {
  process.stderr.write(
    "Use npm run doctor [-- --live]. --live makes small synthetic model/embedding calls; it sends no Slack messages and writes no records.\n",
  );
  process.exitCode = 1;
} else {
  const checks = await checkReadiness(process.env, {
    nodeVersion: process.versions.node,
    live: args.includes("--live"),
    createProbes: createReadinessProbes,
  });
  for (const check of checks)
    process.stdout.write(`[${check.status}] ${check.name}: ${check.detail}\n`);
  if (checks.some((check) => check.status === "FAIL")) process.exitCode = 1;
}
