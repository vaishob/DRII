import { pino } from 'pino';

export function createLogger(level = 'info') {
  return pino({
    level,
    redact: {
      paths: [
        'password',
        'token',
        'apiKey',
        'authorization',
        'content',
        'text',
        'transcript',
        'embedding',
        'OPENAI_API_KEY',
        'CLICKHOUSE_PASSWORD',
        'SLACK_BOT_TOKEN',
        'SLACK_APP_TOKEN',
        '*.password',
        '*.token',
        '*.apiKey',
        '*.authorization',
        '*.content',
        '*.text',
        'req.headers.authorization',
      ],
      censor: '[REDACTED]',
    },
  });
}
