import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import examples from '../../fixtures/contracts/v1/examples.json' with { type: 'json' };
import { loadConfig } from '../../src/config/index.js';
import { DecisionEventSchema } from '../../src/contracts/index.js';
import { createDatabase } from '../../src/data/database.js';
import { ClickHouseDecisionStore } from '../../src/data/decisions.js';
import { setupSchema } from '../../src/data/schema.js';

// Explicitly opt in; these tests append synthetic records to a unique workspace.
describe.skipIf(process.env.DRII_LIVE_TESTS !== '1')(
  'real ClickHouse durability',
  () => {
    it('retains approval and source references after duplicate/out-of-order writes and reconnect', async () => {
      const config = loadConfig();
      const db = createDatabase(config);
      const workspaceId = `integration-${randomUUID()}`;
      const input = JSON.parse(
        JSON.stringify(examples.DecisionEvent).replaceAll(
          'demo-workspace',
          workspaceId,
        ),
      ) as unknown;
      const event = DecisionEventSchema.parse(input);
      const approval = DecisionEventSchema.parse({
        ...event,
        revision: 2,
        eventId: 'approval',
        deduplicationId: 'approve-click',
        eventType: 'APPROVED',
        actor: event.decision.owner,
        decision: {
          ...event.decision,
          revision: 2,
          state: 'APPROVED',
          approval: {
            actor: event.decision.owner,
            optionId: 'pilot',
            approvedRevision: 1,
            approvedAt: event.createdAt,
          },
        },
      });
      try {
        await setupSchema(db);
        const store = new ClickHouseDecisionStore(db);
        await store.appendDecisionEvent(approval);
        await store.appendDecisionEvent(event);
        await store.appendDecisionEvent(approval);
      } finally {
        await db.close();
      }
      const reconnected = createDatabase(config);
      try {
        const store = new ClickHouseDecisionStore(reconnected);
        expect(await store.getDecision(workspaceId, event.decisionId)).toEqual(
          approval.decision,
        );
        expect(
          await store.getDecision('unrelated-workspace', event.decisionId),
        ).toBeNull();
        expect(
          await store.getEventByDeduplicationId(
            workspaceId,
            event.decisionId,
            'approve-click',
          ),
        ).toEqual(approval);
      } finally {
        await reconnected.close();
      }
    }, 60_000);
  },
);
