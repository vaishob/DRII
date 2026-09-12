import { z } from "zod";
import { TRANSCRIPTION_MODEL } from "./limits.js";

const configSchema = z.object({
  SLACK_BOT_TOKEN: z
    .string()
    .startsWith("xoxb-")
    .refine((s) => !s.includes("replace")),
  SLACK_APP_TOKEN: z
    .string()
    .startsWith("xapp-")
    .refine((s) => !s.includes("replace")),
  SLACK_DEMO_CHANNEL_ID: z.string().regex(/^C[A-Z0-9]+$/),
  OPENAI_API_KEY: z.string().optional(),
  DRII_TRANSCRIPTION_MODEL: z
    .literal(TRANSCRIPTION_MODEL)
    .default(TRANSCRIPTION_MODEL),
  DRII_ANALYSIS_MODE: z.literal("fixture").default("fixture"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

export function parseConfig(input: Record<string, string | undefined>) {
  const result = configSchema.safeParse(input);
  if (!result.success) {
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path.join("."))),
    ];
    throw new Error(`Missing or invalid configuration: ${fields.join(", ")}`);
  }
  return result.data;
}

export type Config = ReturnType<typeof parseConfig>;
