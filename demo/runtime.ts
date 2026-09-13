import { z } from 'zod';
import { RoomSessions } from '../src/room/session.js';
import { DecisionEngine } from '../src/intelligence/engine.js';
import { DurableDecisionWorkflow } from '../src/intelligence/workflow.js';
import {
  DemoSources,
  MemoryDecisions,
  ScriptedModel,
} from '../tests/simulation.js';
import { BrowserRecords } from './records.js';

export const SAMPLE_TRANSCRIPT =
  'We must decide whether to launch. All blocking bugs are fixed. Sales wants a broad launch on Friday, while Support needs confirmed coverage before committing to a limited pilot.';

const Id = z.object({ id: z.uuid() });

export function createDemoRuntime(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
) {
  const records = new BrowserRecords(storage);
  const sources = new DemoSources();
  const workflow = new DurableDecisionWorkflow(
    new MemoryDecisions(records),
    sources,
    new DecisionEngine(new ScriptedModel(), sources),
  );
  const sessions = new RoomSessions(
    records,
    workflow,
    'demo-workspace',
    'launch',
    {
      actorId: 'demo-maya',
      displayName: 'Maya (synthetic demo)',
      role: 'Product',
    },
  );

  return async (path: string, input?: unknown): Promise<unknown> => {
    if (path === 'start') return sessions.create();
    if (path === 'transcribe')
      throw new Error(
        'Microphone transcription is unavailable in this scripted browser demo.',
      );
    const { id } = Id.parse(input);
    switch (path) {
      case 'status':
        return sessions.snapshot(id);
      case 'segment':
        return sessions.append(
          id,
          z.object({ segment: z.unknown() }).parse(input).segment,
        );
      case 'review':
        return sessions.review(id);
      case 'stop':
      case 'mute':
      case 'dismiss':
        return sessions.control(id, path);
      default:
        throw new Error('Unknown demo action.');
    }
  };
}
