import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { EMBEDDING_DIMENSIONS } from '../src/contracts/index.js';
import { OpenAIEmbedder } from '../src/data/embeddings.js';

describe('official OpenAI embedding adapter (mock HTTP)', () => {
  it('requests the selected model and dimension, and restores response index order', async () => {
    let request: unknown;
    const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) =>
      i === 0 ? 1 : 0,
    );
    const client = new OpenAI({
      apiKey: 'offline-test',
      maxRetries: 0,
      fetch: async (_url, options) => {
        request = JSON.parse(String(options?.body));
        return new Response(
          JSON.stringify({
            data: [
              { index: 1, embedding: vector.map((n) => n * 2) },
              { index: 0, embedding: vector },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    const result = await new OpenAIEmbedder(loadConfig({}), client).embed([
      'first',
      'second',
    ]);
    expect(request).toMatchObject({
      model: 'text-embedding-3-small',
      dimensions: 1536,
      input: ['first', 'second'],
    });
    expect(result[0]?.[0]).toBe(1);
    expect(result[1]?.[0]).toBe(2);
  });
  it('sanitizes provider errors and requires local credentials for live usage', async () => {
    expect(() => new OpenAIEmbedder(loadConfig({}))).toThrow(
      'Set OPENAI_API_KEY',
    );
    const client = new OpenAI({
      apiKey: 'offline-test',
      maxRetries: 0,
      fetch: async () => new Response('PRIVATE PROVIDER BODY', { status: 401 }),
    });
    await expect(
      new OpenAIEmbedder(loadConfig({}), client).embed(['example']),
    ).rejects.toThrow('Embedding request failed');
  });
});
