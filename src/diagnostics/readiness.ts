import {
  parseConfig,
  requireClickHouse,
  type SlackConfig,
} from '../config/index.js';

export interface ReadinessCheck {
  name: string;
  status: 'PASS' | 'FAIL' | 'PENDING';
  detail: string;
}
export interface ReadinessProbes {
  database(): Promise<void>;
  sources(): Promise<void>;
  slack(): Promise<void>;
  model(): Promise<void>;
  embeddings(): Promise<void>;
  close(): Promise<void>;
}
export async function checkReadiness(
  env: Record<string, string | undefined>,
  options: {
    nodeVersion: string;
    live: boolean;
    createProbes: (config: SlackConfig) => ReadinessProbes;
  },
): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];
  const add = (
    name: string,
    status: ReadinessCheck['status'],
    detail: string,
  ) => checks.push({ name, status, detail });
  add(
    'Node runtime',
    options.nodeVersion.split('.')[0] === '24' ? 'PASS' : 'FAIL',
    'Use Node.js 24, matching package.json and the tested lockfile.',
  );
  add(
    'Live mode',
    env.DRII_ANALYSIS_MODE === 'live' ? 'PASS' : 'FAIL',
    'DRII_ANALYSIS_MODE=live is required for the complete MVP; fixture mode uses scripted responses.',
  );
  let config: SlackConfig;
  try {
    const missing = [
      'OPENAI_API_KEY',
      'CLICKHOUSE_URL',
      'SLACK_BOT_TOKEN',
      'SLACK_APP_TOKEN',
      'SLACK_DEMO_CHANNEL_ID',
      'DRII_DEMO_WORKSPACE_ID',
      'DRII_DECISION_OWNER_ID',
    ].filter((field) => !env[field]?.trim());
    // Audit the entire live path even when the local app defaults to fixture mode.
    let parsed: SlackConfig;
    try {
      parsed = parseConfig({ ...env, DRII_ANALYSIS_MODE: 'live' });
    } catch (error) {
      throw new Error(
        [
          missing.length
            ? `Missing live configuration fields: ${missing.join(', ')}.`
            : '',
          error instanceof Error ? error.message : 'Invalid configuration.',
        ]
          .filter(Boolean)
          .join(' '),
        { cause: error },
      );
    }
    if (missing.length)
      throw new Error(
        `Missing live configuration fields: ${missing.join(', ')}`,
      );
    config = parsed;
    requireClickHouse(config);
    if (/replace|your[-_ ]?key|placeholder/i.test(config.OPENAI_API_KEY ?? ''))
      throw new Error('Replace the OPENAI_API_KEY placeholder in local .env.');
    if (!['http:', 'https:'].includes(new URL(config.OPENAI_BASE_URL).protocol))
      throw new Error('OPENAI_BASE_URL must use HTTP(S).');
    add(
      'Configuration',
      'PASS',
      'Required values are present and well formed; this does not establish account access.',
    );
  } catch (error) {
    add(
      'Configuration',
      'FAIL',
      error instanceof Error
        ? error.message
        : 'Check root .env using .env.example.',
    );
    add(
      'Account checks',
      'PENDING',
      'Complete configuration, then run npm run doctor -- --live.',
    );
    return checks;
  }
  if (!options.live) {
    add(
      'Account checks',
      'PENDING',
      'Not requested. npm run doctor -- --live checks service access and makes small synthetic model/embedding calls.',
    );
    return checks;
  }
  let probes: ReadinessProbes | undefined;
  try {
    probes = options.createProbes(config);
    const run = async (
      name: string,
      operation: () => Promise<void>,
      success: string,
      failure: string,
    ) => {
      try {
        await operation();
        add(name, 'PASS', success);
        return true;
      } catch {
        add(name, 'FAIL', failure);
        return false;
      }
    };
    const databaseReady = await run(
      'ClickHouse schema',
      () => probes!.database(),
      'Connected and found all four application tables.',
      'Check ClickHouse endpoint/credentials, then run npm run db:setup.',
    );
    if (databaseReady)
      await run(
        'Evidence corpus',
        () => probes!.sources(),
        'Current shared source chunks exist in the configured workspace/project and embedding model.',
        'Seed or import sources into the configured scope; use the same embedding model as the application.',
      );
    else
      add(
        'Evidence corpus',
        'PENDING',
        'Requires a reachable application schema.',
      );
    await run(
      'Slack identity and channel',
      () => probes!.slack(),
      'Bot workspace matches configuration and the demo channel is readable.',
      'Check bot token, workspace/channel IDs, channels:history scope and channel membership.',
    );
    await run(
      'Structured text model',
      () => probes!.model(),
      'A synthetic structured Responses API request completed and validated.',
      'Check OpenAI endpoint, key, billing and DRII_TEXT_MODEL access/Structured Outputs support.',
    );
    await run(
      'Embedding model',
      () => probes!.embeddings(),
      'A synthetic embedding request returned a valid 1536-dimensional vector.',
      'Check key, billing, DRII_EMBEDDING_MODEL access and 1536-dimension support.',
    );
  } catch {
    add(
      'Service clients',
      'FAIL',
      'Could not initialize service clients. Check the local configuration.',
    );
  } finally {
    if (probes) {
      try {
        await probes.close();
      } catch {
        add(
          'Client cleanup',
          'FAIL',
          'A service client could not close cleanly.',
        );
      }
    }
  }
  add(
    'Human rehearsal',
    'PENDING',
    'Still required: Socket Mode events, real audio transcription, stakeholder reply, owner approval, restart/read-back and a second teammate rehearsal. See docs/workflow.md.',
  );
  return checks;
}
