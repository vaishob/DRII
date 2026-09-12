import { loadConfig } from '../config/index.js';
import { createLogger } from '../config/logger.js';
import { createDatabase } from './database.js';
import { ClickHouseDecisionStore } from './decisions.js';
import { DEMO_AFTER_REPLY_AS_OF, DEMO_INITIAL_AS_OF } from './demo.js';
import { OpenAIEmbedder } from './embeddings.js';
import { ClickHouseEvidenceRetriever } from './retrieval.js';
import { setupSchema } from './schema.js';
import { seedDemo } from './seed.js';
import { ClickHouseSourceStore } from './sources.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const command = process.argv[2];
async function main(): Promise<void> {
  if (command === 'schema') {
    const admin = createDatabase(config, 'default');
    try {
      await admin.command(
        'CREATE DATABASE IF NOT EXISTS {database:Identifier}',
        { database: config.CLICKHOUSE_DATABASE },
      );
    } finally {
      await admin.close();
    }
  }
  const db = createDatabase(config);
  const startedAt = performance.now();
  try {
    if (command === 'schema') {
      await setupSchema(db);
      logger.info({ operation: 'schema' }, 'ClickHouse schema ready');
    } else if (command === 'health') {
      await db.query('SELECT 1 AS healthy');
      logger.info({ operation: 'health' }, 'ClickHouse connection healthy');
    } else if (command === 'seed' || command === 'reply') {
      const embedder = new OpenAIEmbedder(config);
      const result = await seedDemo(
        new ClickHouseDecisionStore(db),
        new ClickHouseSourceStore(db, embedder),
        command === 'reply',
        {
          workspaceId: config.DRII_DEMO_WORKSPACE_ID,
          projectId: config.DRII_DEMO_PROJECT_ID,
        },
      );
      logger.info(
        {
          operation: command,
          synthetic: true,
          ...result,
          elapsedMs: Math.round(performance.now() - startedAt),
        },
        'Synthetic demo inputs seeded',
      );
    } else if (command === 'query' || command === 'query-after') {
      const query = process.argv.slice(3).join(' ');
      if (!query.trim()) throw new Error('Supply a search query after --');
      const retriever = new ClickHouseEvidenceRetriever(
        db,
        new OpenAIEmbedder(config),
        config.DRII_MIN_RELEVANCE,
      );
      const result = await retriever.retrieveEvidence(query, {
        workspaceId: config.DRII_DEMO_WORKSPACE_ID,
        projectId: config.DRII_DEMO_PROJECT_ID,
        decisionId: 'demo-cli',
        revision: 0,
        asOf: command === 'query' ? DEMO_INITIAL_AS_OF : DEMO_AFTER_REPLY_AS_OF,
      });
      // Explicit CLI inspection output, separate from redacted operational logging.
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      logger.info(
        {
          operation: command,
          synthetic: true,
          status: result.status,
          elapsedMs: Math.round(performance.now() - startedAt),
        },
        'Evidence query completed',
      );
      if (result.status === 'FAILED') process.exitCode = 1;
    } else if (command === 'source') {
      const sourceId = process.argv[3];
      if (!sourceId) throw new Error('Supply the source ID after --');
      const store = new ClickHouseSourceStore(db, {
        model: 'read-only',
        embed: () => Promise.reject(new Error('Read-only source viewer')),
      });
      const source = await store.getSource(
        config.DRII_DEMO_WORKSPACE_ID,
        config.DRII_DEMO_PROJECT_ID,
        sourceId,
        DEMO_AFTER_REPLY_AS_OF,
      );
      if (!source)
        throw new Error('Source unavailable in the shared demo scope');
      process.stdout.write(JSON.stringify(source, null, 2) + '\n');
    } else
      throw new Error(
        'Use db:setup, db:health, db:seed, demo:query, demo:query:after, demo:add-reply or source:show',
      );
  } finally {
    await db.close();
  }
}
main().catch((error: unknown) => {
  logger.error({
    operation: command,
    message:
      error instanceof Error
        ? error.message
        : 'Unexpected data command failure',
  });
  process.exitCode = 1;
});
