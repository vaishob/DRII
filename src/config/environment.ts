import { z } from "zod";

const environmentSchema = z.object({
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_APP_TOKEN: z.string().min(1),
  SLACK_DEMO_CHANNEL_ID: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  CLICKHOUSE_URL: z.string().url(),
  CLICKHOUSE_USER: z.string().min(1),
  CLICKHOUSE_PASSWORD: z.string().min(1),
  CLICKHOUSE_DATABASE: z.string().min(1).default("default"),
  DRII_TEXT_MODEL: z.string().min(1).default("gpt-4.1-2025-04-14"),
  DRII_TRANSCRIPTION_MODEL: z.string().min(1).default("gpt-4o-transcribe-diarize"),
  DRII_EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small"),
});

export type AppConfig = z.infer<typeof environmentSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  return environmentSchema.parse(environment);
}
