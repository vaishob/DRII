import { describe, expect, it, vi } from 'vitest';
import {
  checkReadiness,
  type ReadinessProbes,
} from '../src/diagnostics/readiness.js';

const configured = {
  DRII_ANALYSIS_MODE: 'live',
  OPENAI_API_KEY: 'sk-test-not-a-real-key',
  CLICKHOUSE_URL: 'http://localhost:8123',
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_APP_TOKEN: 'xapp-test',
  SLACK_DEMO_CHANNEL_ID: 'C123',
  DRII_DEMO_WORKSPACE_ID: 'T123',
  DRII_DECISION_OWNER_ID: 'U123',
};
function probes(): ReadinessProbes {
  return {
    database: vi.fn(async () => undefined),
    sources: vi.fn(async () => undefined),
    slack: vi.fn(async () => undefined),
    model: vi.fn(async () => undefined),
    embeddings: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}
describe('MVP readiness diagnostics', () => {
  it('reports missing setup without calling providers or printing supplied secrets', async () => {
    const createProbes = vi.fn(probes);
    const checks = await checkReadiness(
      {
        OPENAI_API_KEY: 'sk-secret-value',
        SLACK_BOT_TOKEN: 'bad-private-token',
      },
      { nodeVersion: '24.21.0', live: true, createProbes },
    );
    expect(checks.find((c) => c.name === 'Configuration')?.status).toBe('FAIL');
    expect(JSON.stringify(checks)).toContain('SLACK_BOT_TOKEN');
    expect(JSON.stringify(checks)).not.toMatch(
      /sk-secret-value|bad-private-token/,
    );
    expect(createProbes).not.toHaveBeenCalled();
  });
  it('distinguishes local validation from account access and fixture mode from a live MVP', async () => {
    const createProbes = vi.fn(probes);
    const checks = await checkReadiness(
      { ...configured, DRII_ANALYSIS_MODE: 'fixture' },
      { nodeVersion: '24.21.0', live: false, createProbes },
    );
    expect(checks.find((c) => c.name === 'Configuration')?.status).toBe('PASS');
    expect(checks.find((c) => c.name === 'Live mode')?.status).toBe('FAIL');
    expect(checks.find((c) => c.name === 'Account checks')?.status).toBe(
      'PENDING',
    );
    expect(createProbes).not.toHaveBeenCalled();
  });
  it('continues independent account checks after failure, sanitizes errors and closes clients', async () => {
    const services = probes();
    services.database = vi.fn(async () => {
      throw new Error('password=private');
    });
    services.model = vi.fn(async () => {
      throw new Error('raw provider payload');
    });
    const checks = await checkReadiness(configured, {
      nodeVersion: '24.21.0',
      live: true,
      createProbes: () => services,
    });
    expect(checks.find((c) => c.name === 'ClickHouse schema')?.status).toBe(
      'FAIL',
    );
    expect(services.sources).not.toHaveBeenCalled();
    expect(services.slack).toHaveBeenCalledOnce();
    expect(services.embeddings).toHaveBeenCalledOnce();
    expect(services.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(checks)).not.toMatch(
      /password=private|raw provider payload/,
    );
  });
  it('leaves human rehearsal pending even when every connectivity probe passes', async () => {
    const checks = await checkReadiness(configured, {
      nodeVersion: '24.21.0',
      live: true,
      createProbes: probes,
    });
    expect(checks.filter((c) => c.status === 'FAIL')).toHaveLength(0);
    expect(checks.at(-1)).toMatchObject({
      name: 'Human rehearsal',
      status: 'PENDING',
    });
  });
});
