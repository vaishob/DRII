import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EMBEDDING_DIMENSIONS, type Source } from '../contracts/index.js';

export const CHUNK_CHARACTERS = 900;
export const MAX_DOCUMENT_CHARACTERS = 24_000;
export const VectorSchema = z
  .array(z.number().finite())
  .length(EMBEDDING_DIMENSIONS)
  .refine(
    (v) => v.some((n) => n !== 0),
    'An embedding cannot be a zero vector',
  );
export interface Embedder {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}
export interface Chunk {
  chunkId: string;
  excerpt: string;
}
export function chunkSource(source: Source): Chunk[] {
  if (source.content.length > MAX_DOCUMENT_CHARACTERS)
    throw new Error('Document exceeds demo ingestion size limit');
  const chunks: Chunk[] = [];
  for (
    let offset = 0;
    offset < source.content.length;
    offset += CHUNK_CHARACTERS
  ) {
    const excerpt = source.content.slice(offset, offset + CHUNK_CHARACTERS);
    const hash = createHash('sha256')
      .update(
        JSON.stringify([
          source.workspaceId,
          source.projectId,
          source.sourceId,
          source.revision,
          offset,
          excerpt,
        ]),
      )
      .digest('hex')
      .slice(0, 24);
    chunks.push({ chunkId: hash, excerpt });
  }
  return chunks;
}
