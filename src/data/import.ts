import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { SourceSchema, type Source } from '../contracts/index.js';
import type { SourceStore } from '../contracts/services.js';
import { validateSourceForIngestion } from './sources.js';

export const MAX_IMPORT_BYTES = 3_000_000;
export const MAX_IMPORT_RECORDS = 100;
export interface ImportScope {
  workspaceId: string;
  projectId: string;
}

export function parseSourceImport(
  input: unknown,
  scope: ImportScope,
): Source[] {
  const parsed = z
    .array(SourceSchema)
    .min(1)
    .max(MAX_IMPORT_RECORDS)
    .safeParse(Array.isArray(input) ? input : [input]);
  if (!parsed.success)
    throw new Error(
      'Invalid source import. Supply a Source object or 1–100 Source records matching the shared contracts.',
    );
  const revisions = new Set<string>();
  for (const [index, source] of parsed.data.entries()) {
    if (
      source.workspaceId !== scope.workspaceId ||
      source.projectId !== scope.projectId
    )
      throw new Error(
        `Import record ${index + 1} does not match the configured workspace and project.`,
      );
    try {
      validateSourceForIngestion(source);
    } catch {
      throw new Error(
        `Import record ${index + 1} has invalid dates, duplicate metrics, a storage revision overflow, or more than 24,000 characters.`,
      );
    }
    const key = JSON.stringify([source.sourceId, source.revision]);
    if (revisions.has(key))
      throw new Error(
        `Import record ${index + 1} repeats a source revision. Include each source/revision only once.`,
      );
    revisions.add(key);
  }
  return parsed.data;
}

export async function readSourceImport(
  path: string,
  scope: ImportScope,
): Promise<Source[]> {
  let contents: string;
  try {
    const file = await stat(path);
    if (!file.isFile() || file.size > MAX_IMPORT_BYTES)
      throw new Error(
        'Import must be a regular JSON file no larger than 3 MB.',
      );
    contents = await readFile(path, 'utf8');
  } catch {
    throw new Error(
      'Cannot read source import. Supply an accessible JSON file no larger than 3 MB.',
    );
  }
  if (Buffer.byteLength(contents, 'utf8') > MAX_IMPORT_BYTES)
    throw new Error('Source import exceeds the 3 MB limit.');
  let input: unknown;
  try {
    input = JSON.parse(contents.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('Source import is not valid JSON.');
  }
  return parseSourceImport(input, scope);
}

export async function importSources(
  input: unknown,
  scope: ImportScope,
  store: Pick<SourceStore, 'ingestSource'>,
): Promise<{ records: number; logicalSources: number }> {
  // Preflight the whole batch. Provider failures can still stop it partway;
  // identical source revisions are safe to retry through the store.
  const sources = parseSourceImport(input, scope);
  for (const [index, source] of sources.entries()) {
    try {
      await store.ingestSource(source);
    } catch {
      throw new Error(
        `Source import stopped at record ${index + 1}. Earlier records may be saved. Check provider access or revision conflicts, then retry the same file.`,
      );
    }
  }
  return {
    records: sources.length,
    logicalSources: new Set(sources.map((source) => source.sourceId)).size,
  };
}
