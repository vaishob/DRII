import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  MeetingSchema,
  SourceSchema,
  type Source,
} from '../contracts/index.js';
import type { DecisionStore, SourceStore } from '../contracts/services.js';

// Input fixtures only. Runtime modules never import fixtures/evaluation.
export async function seedDemo(
  decisions: Pick<DecisionStore, 'ingestMeeting'>,
  sources: Pick<SourceStore, 'ingestSource'>,
  includeFollowUp = false,
  scope = { workspaceId: 'demo-workspace', projectId: 'launch' },
): Promise<{ records: number; logicalSources: number }> {
  const scopedSource = (source: Source) =>
    SourceSchema.parse({
      ...source,
      ...scope,
      url: `drii://${encodeURIComponent(scope.workspaceId)}/${encodeURIComponent(scope.projectId)}/${encodeURIComponent(source.sourceId)}`,
    });
  const documents = z
    .array(SourceSchema)
    .parse(JSON.parse(await readFile('fixtures/demo/sources.json', 'utf8')))
    .map(scopedSource);
  const meeting = MeetingSchema.parse(
    JSON.parse(await readFile('fixtures/demo/meeting.json', 'utf8')),
  );
  await decisions.ingestMeeting(
    MeetingSchema.parse({
      ...meeting,
      ...scope,
      segments: meeting.segments.map((segment) => ({
        ...segment,
        workspaceId: scope.workspaceId,
      })),
    }),
  );
  for (const document of documents) await sources.ingestSource(document);
  if (includeFollowUp) {
    const reply = scopedSource(
      SourceSchema.parse(
        JSON.parse(await readFile('fixtures/demo/follow-up.json', 'utf8')),
      ),
    );
    await sources.ingestSource(reply);
    documents.push(reply);
  }
  return {
    records: documents.length,
    logicalSources: new Set(documents.map((d) => d.sourceId)).size,
  };
}
