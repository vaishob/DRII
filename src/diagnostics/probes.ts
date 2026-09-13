import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { WebClient, LogLevel } from '@slack/web-api';
import { z } from 'zod';
import type { SlackConfig } from '../config/index.js';
import { createDatabase } from '../data/database.js';
import { OpenAIEmbedder } from '../data/embeddings.js';
import { CURRENT_SOURCES_SQL } from '../data/sources.js';
import type { ReadinessProbes } from './readiness.js';

const PROBE_TIMEOUT_MS = 15_000;
const ProbeResponse = z.object({ status: z.literal('ready') }).strict();
const TABLES = [
  'drii_records_v1',
  'drii_meetings_v1',
  'drii_decision_events_v1',
  'drii_sources_v1',
];

export function createReadinessProbes(config: SlackConfig): ReadinessProbes {
  const db = createDatabase({
    ...config,
    CLICKHOUSE_TIMEOUT_MS: PROBE_TIMEOUT_MS,
  });
  const openai = new OpenAI({
    apiKey: config.OPENAI_API_KEY!,
    baseURL: config.OPENAI_BASE_URL,
    timeout: PROBE_TIMEOUT_MS,
    maxRetries: 0,
  });
  const slack = new WebClient(config.SLACK_BOT_TOKEN, {
    timeout: PROBE_TIMEOUT_MS,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    logLevel: LogLevel.ERROR,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
      setLevel() {},
      getLevel() {
        return LogLevel.ERROR;
      },
      setName() {},
    },
  });
  return {
    async database() {
      await db.query('SELECT 1 AS healthy');
      const rows = await db.query(
        'SELECT name FROM system.tables WHERE database = {database:String}',
        { database: config.CLICKHOUSE_DATABASE },
      );
      const names = new Set(
        rows.map((row) => z.object({ name: z.string() }).parse(row).name),
      );
      if (TABLES.some((table) => !names.has(table)))
        throw new Error('Schema incomplete');
    },
    async sources() {
      const rows = await db.query(
        `SELECT count() AS count FROM (${CURRENT_SOURCES_SQL})
        WHERE embedding_model = {model:String} AND length(chunks) > 0`,
        {
          workspace: config.DRII_DEMO_WORKSPACE_ID,
          project: config.DRII_DEMO_PROJECT_ID,
          asOf: Date.now(),
          model: config.DRII_EMBEDDING_MODEL,
        },
      );
      if (
        !rows[0] ||
        z.object({ count: z.coerce.number().positive() }).safeParse(rows[0])
          .success === false
      )
        throw new Error('No shared corpus');
    },
    async slack() {
      const identity = await slack.auth.test();
      if (
        !identity.ok ||
        !identity.bot_id ||
        identity.team_id !== config.DRII_DEMO_WORKSPACE_ID
      )
        throw new Error('Slack identity mismatch');
      const history = await slack.conversations.history({
        channel: config.SLACK_DEMO_CHANNEL_ID,
        limit: 1,
      });
      if (!history.ok) throw new Error('Channel unavailable');
    },
    async model() {
      const result = await openai.responses.parse({
        model: config.DRII_TEXT_MODEL,
        store: false,
        max_output_tokens: 128,
        input: 'This is a synthetic connectivity check. Return status ready.',
        text: { format: zodTextFormat(ProbeResponse, 'drii_readiness') },
      });
      if (result.status !== 'completed')
        throw new Error('Incomplete model result');
      ProbeResponse.parse(result.output_parsed);
    },
    async embeddings() {
      await new OpenAIEmbedder(config, openai).embed([
        'Synthetic DRII readiness check.',
      ]);
    },
    close: () => db.close(),
  };
}
