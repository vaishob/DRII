import { describe, expect, it, vi } from 'vitest';
import documents from '../fixtures/demo/sources.json' with { type: 'json' };
import { SourceSchema } from '../src/contracts/index.js';
import type { SourceStore } from '../src/contracts/services.js';
import {
  importSources,
  parseSourceImport,
  readSourceImport,
} from '../src/data/import.js';

const scope = { workspaceId: 'demo-workspace', projectId: 'launch' };
const source = SourceSchema.parse(documents[0]);

describe('organization source imports', () => {
  it('accepts a source or a bounded batch without rewriting attribution or scope', async () => {
    const store = {
      ingestSource: vi.fn<SourceStore['ingestSource']>().mockResolvedValue(),
    };
    const realSource = {
      ...source,
      synthetic: false,
      title: 'Engineering readiness',
      url: 'https://example.org/engineering',
    };
    expect(parseSourceImport(realSource, scope)).toEqual([realSource]);
    expect(await importSources([realSource], scope, store)).toEqual({
      records: 1,
      logicalSources: 1,
    });
    expect(store.ingestSource).toHaveBeenCalledWith(realSource);
    expect(
      await readSourceImport('fixtures/demo/sources.json', scope),
    ).toHaveLength(documents.length);
  });
  it('validates the entire batch before writing, including dates, scope, size and duplicate revisions', async () => {
    const store = {
      ingestSource: vi.fn<SourceStore['ingestSource']>().mockResolvedValue(),
    };
    for (const bad of [
      { ...source, workspaceId: 'another-workspace' },
      { ...source, projectId: 'another-project' },
      { ...source, content: 'x'.repeat(24_001) },
      { ...source, revision: 2 ** 32 },
      {
        ...source,
        metrics: [{ ...source.metrics[0], measuredAt: '2027-01-01T00:00:00Z' }],
      },
      {
        ...source,
        metrics: [source.metrics[0], { ...source.metrics[0], value: 99 }],
      },
      { ...source, content: undefined },
    ]) {
      await expect(
        importSources([source, bad], scope, store),
      ).rejects.toThrow();
    }
    await expect(importSources([source, source], scope, store)).rejects.toThrow(
      'repeats a source revision',
    );
    await expect(importSources([], scope, store)).rejects.toThrow();
    await expect(
      importSources(
        Array.from({ length: 101 }, () => source),
        scope,
        store,
      ),
    ).rejects.toThrow();
    expect(store.ingestSource).not.toHaveBeenCalled();
  });
  it('reports a partial provider failure without disclosing content and supports replay of the validated batch', async () => {
    const store = {
      ingestSource: vi
        .fn<SourceStore['ingestSource']>()
        .mockResolvedValueOnce()
        .mockRejectedValueOnce(new Error('secret provider response')),
    };
    const input = documents.slice(0, 3);
    await expect(importSources(input, scope, store)).rejects.toThrow(
      'stopped at record 2',
    );
    expect(store.ingestSource).toHaveBeenCalledTimes(2);
    store.ingestSource.mockReset().mockResolvedValue();
    expect(await importSources(input, scope, store)).toEqual({
      records: 3,
      logicalSources: 3,
    });
    expect(store.ingestSource).toHaveBeenCalledTimes(3);
    await expect(readSourceImport('fixtures/demo', scope)).rejects.toThrow(
      'Cannot read source import',
    );
  });
});
