import { createClient } from "@clickhouse/client";
import { loadConfig } from "./config/environment.js";
import { createDecisionEventsTable } from "./data/schema.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = createClient({
    url: config.CLICKHOUSE_URL,
    username: config.CLICKHOUSE_USER,
    password: config.CLICKHOUSE_PASSWORD,
    database: config.CLICKHOUSE_DATABASE,
  });
  await createDecisionEventsTable(client, config.CLICKHOUSE_DATABASE);
  await client.close();
}

void main();
