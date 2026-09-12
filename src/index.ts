import OpenAI from 'openai';
import { createLogger } from './config/logger.js';
import { createTranscriber } from './audio/transcribe.js';
import { parseConfig } from './config/index.js';
import { SHUTDOWN_TIMEOUT_MS } from './config/limits.js';
import { createSlackApp } from './slack/app.js';
import { fixtureAnalyzer } from './slack/fixture-analyzer.js';
import { MemoryRunStore } from './slack/run-store.js';

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
  const client = config.OPENAI_API_KEY?.trim()
    ? new OpenAI({
        apiKey: config.OPENAI_API_KEY,
        baseURL: config.OPENAI_BASE_URL,
      })
    : undefined;
  const app = createSlackApp(config, {
    analyzer: fixtureAnalyzer,
    transcriber: createTranscriber(client),
    store: new MemoryRunStore(),
    logger,
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
    deadline.unref();
    try {
      await app.stop();
    } finally {
      clearTimeout(deadline);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void stop().catch(() => {
        process.exitCode = 1;
      });
    });
  }
  await app.start();
  logger.info(
    {
      analysisMode: 'fixture',
      storage: 'memory',
      audioEnabled: Boolean(client),
    },
    'DRII connected. Decision cards contain labeled sample data; live reasoning is not wired yet.',
  );
}

void start().catch(() => {
  logger.error(
    { code: 'STARTUP_FAILED' },
    'DRII could not connect. Check Slack tokens, app installation, and network access.',
  );
  process.exitCode = 1;
});
