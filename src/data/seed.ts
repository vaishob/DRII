import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { MeetingSchema, SourceSchema } from '../contracts/index.js';
import type { DecisionStore, SourceStore } from '../contracts/services.js';

// Input fixtures only. Runtime modules never import fixtures/evaluation.
export async function seedDemo(
  decisions: DecisionStore,
  sources: SourceStore,
  includeFollowUp = false,
): Promise<{ records: number; logicalSources: number }> {
  const documents = z
    .array(SourceSchema)
    .parse(JSON.parse(await readFile('fixtures/demo/sources.json', 'utf8')));
  const meeting = MeetingSchema.parse(
    JSON.parse(await readFile('fixtures/demo/meeting.json', 'utf8')),
  );
  await decisions.ingestMeeting(meeting);
  for (const document of documents) await sources.ingestSource(document);
  if (includeFollowUp) {
    const reply = SourceSchema.parse(
      JSON.parse(await readFile('fixtures/demo/follow-up.json', 'utf8')),
    );
    await sources.ingestSource(reply);
    documents.push(reply);
  }
  return {
    records: documents.length,
    logicalSources: new Set(documents.map((d) => d.sourceId)).size,
  };
}
