import { z } from 'zod';

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const ConfigSchema = z.object({
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  CLICKHOUSE_URL: z.url().optional(),
  CLICKHOUSE_USER: z.string().min(1).default('default'),
  CLICKHOUSE_PASSWORD: z.string().default(''),
  CLICKHOUSE_DATABASE: z
    .string()
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
    .default('drii'),
  CLICKHOUSE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(120_000)
    .default(DEFAULT_REQUEST_TIMEOUT_MS),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.url().default('https://api.openai.com/v1'),
  DRII_TEXT_MODEL: z.string().min(1).default('gpt-4.1-2025-04-14'),
  DRII_TRANSCRIPTION_MODEL: z
    .string()
    .min(1)
    .default('gpt-4o-transcribe-diarize'),
  DRII_EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-small'),
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_DEMO_CHANNEL_ID: z.string().optional(),
});
export type Config = z.infer<typeof ConfigSchema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid configuration fields: ${result.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  return result.data;
}
export function requireClickHouse(config: Config): string {
  if (!config.CLICKHOUSE_URL || config.CLICKHOUSE_URL.includes('your-service'))
    throw new Error(
      'Set CLICKHOUSE_URL in root .env to the ClickHouse HTTP(S) endpoint',
    );
  const url = new URL(config.CLICKHOUSE_URL);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error(
      'CLICKHOUSE_URL must contain only an HTTP(S) origin; configure user, password and database separately',
    );
  return url.href;
}
