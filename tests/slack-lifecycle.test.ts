import { createServer } from 'node:https';
import { App } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import { expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config/index.js';
import {
  slackClientOptions,
  slackSdkLogger,
  verifySlackStartup,
  withSlackLifecycle,
} from '../src/slack/lifecycle.js';

const config = parseConfig({
  DRII_ANALYSIS_MODE: 'live',
  DRII_DEMO_WORKSPACE_ID: 'TDEMO',
  DRII_DECISION_OWNER_ID: 'UOWNER',
  SLACK_DEMO_CHANNEL_ID: 'CDEMO',
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_APP_TOKEN: 'xapp-test',
  OPENAI_API_KEY: 'sk-test',
  CLICKHOUSE_URL: 'http://localhost:8123',
});
function identity(client: WebClient) {
  const auth = vi.spyOn(client.auth, 'test').mockResolvedValue({
    ok: true,
    bot_id: 'BDEMO',
    user_id: 'UBOT',
    team_id: 'TDEMO',
  });
  const history = vi
    .spyOn(client.conversations, 'history')
    .mockResolvedValue({ ok: true, messages: [] });
  return { auth, history };
}

it('requires a real bot identity in the configured workspace and channel access before starting Socket Mode', async () => {
  const app = new App({
    token: 'xoxb-test',
    appToken: 'xapp-test',
    socketMode: true,
    tokenVerificationEnabled: false,
  });
  const probes = identity(app.client);
  const receiverStart = vi
    .spyOn(app, 'start')
    .mockResolvedValue(createServer());
  withSlackLifecycle(app, config);
  probes.auth.mockResolvedValueOnce({
    ok: true,
    bot_id: 'BOTHER',
    user_id: 'UOTHER',
    team_id: 'TOTHER',
  });
  await expect(app.start()).rejects.toThrow('Slack startup checks failed');
  expect(receiverStart).not.toHaveBeenCalled();
  expect(probes.history).not.toHaveBeenCalled();
  await app.start();
  expect(receiverStart).toHaveBeenCalledOnce();
  expect(probes.history).toHaveBeenCalledWith({ channel: 'CDEMO', limit: 1 });
});

it('sanitizes failed preflight and SDK log payloads and disables hidden write retries', async () => {
  const client = new WebClient('xoxb-test', slackClientOptions());
  const probes = identity(client);
  probes.auth.mockRejectedValue(
    new Error('Authorization: Bearer xoxb-private'),
  );
  await expect(verifySlackStartup(client, config)).rejects.not.toThrow(
    'xoxb-private',
  );
  expect(slackClientOptions()).toMatchObject({
    timeout: 15_000,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
  });
  const logger = { warn: vi.fn(), error: vi.fn() };
  const sdk = slackSdkLogger(logger);
  sdk.error();
  expect(JSON.stringify(logger.error.mock.calls)).toContain('SLACK_SDK_ERROR');
});

it('disconnects once, drains existing handlers and rejects new work before shared storage can close', async () => {
  const app = new App({
    token: 'xoxb-test',
    appToken: 'xapp-test',
    socketMode: true,
    tokenVerificationEnabled: false,
  });
  const receiverStop = vi.spyOn(app, 'stop').mockResolvedValue(undefined);
  const use = vi.spyOn(app, 'use');
  withSlackLifecycle(app, config);
  const middleware = use.mock.calls[0]![0]!;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = vi.fn(() => blocked);
  const handling = middleware({ next } as unknown as Parameters<
    typeof middleware
  >[0]);
  let drained = false;
  const stopping = app.stop().then(() => {
    drained = true;
  });
  const duplicate = app.stop();
  await Promise.resolve();
  expect(receiverStop).toHaveBeenCalledOnce();
  expect(drained).toBe(false);
  const unwanted = vi.fn(async () => undefined);
  await middleware({ next: unwanted } as unknown as Parameters<
    typeof middleware
  >[0]);
  expect(unwanted).not.toHaveBeenCalled();
  release();
  await handling;
  await Promise.all([stopping, duplicate]);
  expect(drained).toBe(true);
  expect(next).toHaveBeenCalledOnce();
});
