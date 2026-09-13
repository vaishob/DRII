import OpenAI from 'openai';
import { createLogger } from './config/logger.js';
import { createTranscriber } from './audio/transcribe.js';
import { parseConfig } from './config/index.js';
import { SHUTDOWN_TIMEOUT_MS } from './config/limits.js';
import { createSlackApp } from './slack/app.js';
import { fixtureAnalyzer } from './slack/fixture-analyzer.js';
import { MemoryRunStore } from './slack/run-store.js';
import { createDatabase } from './data/database.js';
import { setupSchema } from './data/schema.js';
import { ClickHouseDecisionStore } from './data/decisions.js';
import { ClickHouseSourceStore } from './data/sources.js';
import { ClickHouseRecords } from './data/records.js';
import { OpenAIEmbedder } from './data/embeddings.js';
import { ClickHouseEvidenceRetriever } from './data/retrieval.js';
import { OpenAIReasoningModel } from './intelligence/model.js';
import { DecisionEngine } from './intelligence/engine.js';
import { AssumptionMonitor } from './intelligence/monitor.js';
import { DurableDecisionWorkflow } from './intelligence/workflow.js';
import { createLiveSlackApp } from './slack/live-app.js';
import { downloadSlackFile } from './audio/download.js';
import { RoomSessions } from './room/session.js';
import { configuredRoomServer, ROOM_PORT } from './room/server.js';
import {
  RuntimeResources,
  StartupError,
  SLACK_STARTUP_TIMEOUT_MS,
} from './runtime.js';

const logger = createLogger();

async function start(): Promise<void> {
  let config;
  try {
    config = parseConfig(process.env);
  } catch (error) {
    logger.error(
      {
        configuration:
          error instanceof Error ? error.message : 'Invalid configuration',
      },
      'Startup configuration failed',
    );
    process.exitCode = 1;
    return;
  }
  logger.level = config.LOG_LEVEL;
  const resources = new RuntimeResources();
  try {
    const client = config.OPENAI_API_KEY?.trim()
      ? new OpenAI({
          apiKey: config.OPENAI_API_KEY,
          baseURL: config.OPENAI_BASE_URL,
        })
      : undefined;
    const db =
      config.DRII_ANALYSIS_MODE === 'live' ? createDatabase(config) : null;
    if (db) {
      resources.defer(() => db.close());
      await resources.stage('ClickHouse schema setup', () => setupSchema(db));
    }
    const embedder = db ? new OpenAIEmbedder(config) : null;
    const workflow =
      db && embedder
        ? new DurableDecisionWorkflow(
            new ClickHouseDecisionStore(db),
            new ClickHouseSourceStore(db, embedder),
            new DecisionEngine(
              new OpenAIReasoningModel(config),
              new ClickHouseEvidenceRetriever(
                db,
                embedder,
                config.DRII_MIN_RELEVANCE,
              ),
            ),
          )
        : null;
    const roomServer =
      db && workflow && config.DRII_ROOM_ENABLED === '1'
        ? await configuredRoomServer(
            new RoomSessions(
              new ClickHouseRecords(db),
              workflow,
              config.DRII_DEMO_WORKSPACE_ID,
              config.DRII_DEMO_PROJECT_ID,
              {
                actorId: config.DRII_DECISION_OWNER_ID,
                displayName: config.DRII_DECISION_OWNER_ID,
                role: 'Configured owner',
              },
            ),
            config,
          )
        : null;
    if (roomServer) {
      resources.defer(
        () =>
          new Promise<void>((resolve) => {
            roomServer.close(() => resolve());
          }),
      );
      await resources.stage(
        'room listener',
        () =>
          new Promise<void>((resolve, reject) => {
            roomServer.once('error', reject);
            roomServer.listen(ROOM_PORT, '127.0.0.1', () => {
              roomServer.removeListener('error', reject);
              resolve();
            });
          }),
      );
    }
    const app =
      db && embedder && workflow
        ? createLiveSlackApp(config, {
            workflow,
            records: new ClickHouseRecords(db),
            monitor: new AssumptionMonitor(
              new ClickHouseSourceStore(db, embedder),
              new ClickHouseRecords(db),
            ),
            transcriber: createTranscriber(
              client,
              config.DRII_TRANSCRIPTION_MODEL,
            ),
            download: (url, maxBytes) =>
              downloadSlackFile(url, config.SLACK_BOT_TOKEN, maxBytes),
            logger,
          })
        : createSlackApp(config, {
            analyzer: fixtureAnalyzer,
            transcriber: createTranscriber(
              client,
              config.DRII_TRANSCRIPTION_MODEL,
            ),
            store: new MemoryRunStore(),
            logger,
          });
    resources.defer(() => app.stop());
    await resources.stage(
      'Slack identity and Socket Mode connection',
      () => app.start(),
      SLACK_STARTUP_TIMEOUT_MS,
    );
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      const deadline = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
      deadline.unref();
      // The unreferenced deadline must remain until natural process exit:
      // disconnecting a receiver alone does not terminate in-flight requests.
      await resources.close();
    };
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        void stop().catch(() => {
          process.exitCode = 1;
        });
      });
    }
    logger.info(
      {
        analysisMode: config.DRII_ANALYSIS_MODE,
        storage: db ? 'clickhouse' : 'memory',
        audioEnabled: Boolean(client),
      },
      config.DRII_ANALYSIS_MODE === 'live'
        ? 'DRII connected with live reasoning and durable decision storage.'
        : 'DRII connected in labeled fixture mode.',
    );
  } catch (error) {
    const deadline = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
    deadline.unref();
    try {
      await resources.close();
    } catch {
      logger.error(
        { code: 'CLEANUP_FAILED' },
        'A runtime resource could not close.',
      );
    }
    throw error;
  }
}

void start().catch((error: unknown) => {
  logger.error(
    { code: 'STARTUP_FAILED' },
    error instanceof StartupError
      ? error.message
      : 'DRII could not start. Run npm run doctor and check the configured services.',
  );
  process.exitCode = 1;
});
