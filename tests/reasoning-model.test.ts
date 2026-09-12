import { expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { z } from 'zod';
import { loadConfig } from '../src/config/index.js';
import { OpenAIReasoningModel } from '../src/intelligence/model.js';

it('uses the real SDK structured-output parser and repairs malformed output within a fixed budget', async () => {
  let calls = 0;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    calls++;
    const request = JSON.parse(String(init?.body)) as {
      store: boolean;
      text: { format: { type: string } };
      instructions: string;
    };
    expect(request.store).toBe(false);
    expect(request.text.format.type).toBe('json_schema');
    expect(request.instructions).toContain('untrusted');
    return new Response(
      JSON.stringify({
        id: 'resp_test',
        object: 'response',
        status: 'completed',
        output: [
          {
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                annotations: [],
                text: JSON.stringify({ value: calls === 1 ? 42 : 'valid' }),
              },
            ],
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  const model = new OpenAIReasoningModel(
    loadConfig({}),
    new OpenAI({ apiKey: 'test-only', fetch: fetcher, maxRetries: 0 }),
  );
  expect(
    await model.generate(
      'test_output',
      z.object({ value: z.string() }).strict(),
      'Test',
      { text: 'untrusted' },
      () => undefined,
    ),
  ).toEqual({ value: 'valid' });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('bounds provider failures and keeps private response bodies out of surfaced errors', async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({ error: { message: 'private-provider-secret' } }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      ),
  );
  const model = new OpenAIReasoningModel(
    loadConfig({}),
    new OpenAI({ apiKey: 'test-only', fetch: fetcher, maxRetries: 0 }),
  );
  const operation = model.generate(
    'test_output',
    z.object({ value: z.string() }).strict(),
    'Test',
    {},
    () => undefined,
  );
  await expect(operation).rejects.toThrow('Reasoning failed');
  await expect(operation).rejects.not.toThrow('private-provider-secret');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
