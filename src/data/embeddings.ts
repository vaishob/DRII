import OpenAI from 'openai';
import type { Config } from '../config/index.js';
import { EMBEDDING_DIMENSIONS } from '../contracts/index.js';
import { VectorSchema, type Embedder } from './chunks.js';

export const EMBEDDING_TIMEOUT_MS = 15_000;
export const EMBEDDING_BATCH_SIZE = 32;
export class EmbeddingError extends Error {
  constructor() {
    super(
      'Embedding request failed. Check OpenAI configuration, model access and rate limits.',
    );
    this.name = 'EmbeddingError';
  }
}
export class OpenAIEmbedder implements Embedder {
  readonly model: string;
  private readonly client: OpenAI;
  constructor(config: Config, client?: OpenAI) {
    this.model = config.DRII_EMBEDDING_MODEL;
    if (
      !client &&
      (!config.OPENAI_API_KEY || config.OPENAI_API_KEY === 'replace-me')
    )
      throw new Error(
        'Set OPENAI_API_KEY in root .env before embedding demo sources',
      );
    this.client =
      client ??
      new OpenAI({
        apiKey: config.OPENAI_API_KEY!,
        baseURL: config.OPENAI_BASE_URL,
        timeout: EMBEDDING_TIMEOUT_MS,
        maxRetries: 1,
      });
  }
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const vectors: number[][] = [];
    try {
      for (
        let offset = 0;
        offset < texts.length;
        offset += EMBEDDING_BATCH_SIZE
      ) {
        const batch = texts.slice(offset, offset + EMBEDDING_BATCH_SIZE);
        const result = await this.client.embeddings.create({
          model: this.model,
          dimensions: EMBEDDING_DIMENSIONS,
          input: batch,
          encoding_format: 'float',
        });
        const ordered = [...result.data].sort((a, b) => a.index - b.index);
        if (
          ordered.length !== batch.length ||
          ordered.some((row, i) => row.index !== i)
        )
          throw new EmbeddingError();
        vectors.push(
          ...ordered.map((row) => VectorSchema.parse(row.embedding)),
        );
      }
      return vectors;
    } catch {
      throw new EmbeddingError();
    }
  }
}
