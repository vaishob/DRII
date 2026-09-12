import { describe, expect, it } from 'vitest';
import examples from '../fixtures/contracts/v1/examples.json' with { type: 'json' };
import * as contracts from '../src/contracts/index.js';
import { loadConfig, requireClickHouse } from '../src/config/index.js';

describe('version 1 contracts', () => {
  it('validates every published boundary example', () => {
    expect(contracts.MeetingSchema.parse(examples.Meeting)).toEqual(
      examples.Meeting,
    );
    expect(
      contracts.TranscriptSegmentSchema.parse(examples.TranscriptSegment),
    ).toEqual(examples.TranscriptSegment);
    expect(contracts.DecisionSchema.parse(examples.Decision)).toEqual(
      examples.Decision,
    );
    expect(contracts.OptionSchema.parse(examples.Option)).toEqual(
      examples.Option,
    );
    expect(contracts.ClaimSchema.parse(examples.Claim)).toEqual(examples.Claim);
    expect(contracts.EvidenceSchema.parse(examples.Evidence)).toEqual(
      examples.Evidence,
    );
    expect(contracts.FollowUpSchema.parse(examples.FollowUp)).toEqual(
      examples.FollowUp,
    );
    expect(contracts.ActionSchema.parse(examples.Action)).toEqual(
      examples.Action,
    );
    expect(contracts.AssumptionSchema.parse(examples.Assumption)).toEqual(
      examples.Assumption,
    );
    expect(contracts.DecisionEventSchema.parse(examples.DecisionEvent)).toEqual(
      examples.DecisionEvent,
    );
  });
  it('rejects another workspace, duplicate segment IDs and backwards audio times', () => {
    const meeting = structuredClone(examples.Meeting);
    meeting.segments[0]!.workspaceId = 'private-workspace';
    expect(contracts.MeetingSchema.safeParse(meeting).success).toBe(false);
    expect(
      contracts.MeetingSchema.safeParse({
        ...examples.Meeting,
        segments: [examples.TranscriptSegment, examples.TranscriptSegment],
      }).success,
    ).toBe(false);
    expect(
      contracts.TranscriptSegmentSchema.safeParse({
        ...examples.TranscriptSegment,
        endMs: 0,
      }).success,
    ).toBe(false);
  });
  it('rejects missing evidence, invented recommendation IDs and cross-decision records', () => {
    expect(
      contracts.DecisionSchema.safeParse({ ...examples.Decision, evidence: [] })
        .success,
    ).toBe(false);
    expect(
      contracts.DecisionSchema.safeParse({
        ...examples.Decision,
        recommendedOptionId: 'missing',
      }).success,
    ).toBe(false);
    expect(
      contracts.DecisionSchema.safeParse({
        ...examples.Decision,
        options: [{ ...examples.Option, decisionId: 'other' }],
      }).success,
    ).toBe(false);
  });
  it('requires an owner approval of the preceding reviewed revision', () => {
    const approved = {
      ...examples.Decision,
      revision: 2,
      state: 'APPROVED',
      approval: {
        actor: examples.Meeting.owner,
        optionId: 'pilot',
        approvedRevision: 1,
        approvedAt: examples.Decision.createdAt,
      },
    };
    expect(contracts.DecisionSchema.safeParse(approved).success).toBe(true);
    expect(
      contracts.DecisionSchema.safeParse({
        ...approved,
        approval: { ...approved.approval, approvedRevision: 0 },
      }).success,
    ).toBe(false);
    expect(
      contracts.DecisionSchema.safeParse({
        ...approved,
        approval: {
          ...approved.approval,
          actor: { ...approved.approval.actor, actorId: 'someone-else' },
        },
      }).success,
    ).toBe(false);
    expect(
      contracts.DecisionSchema.safeParse({
        ...approved,
        state: 'READY_FOR_REVIEW',
      }).success,
    ).toBe(false);
  });
  it('rejects event envelope mismatches and unconfirmed priority weights', () => {
    expect(
      contracts.DecisionEventSchema.safeParse({
        ...examples.DecisionEvent,
        revision: 9,
      }).success,
    ).toBe(false);
    expect(
      contracts.DecisionSchema.safeParse({
        ...examples.Decision,
        priorities: [{ ...examples.Decision.priorities[0], weight: 1 }],
      }).success,
    ).toBe(false);
  });
  it('preserves Slack timestamps as strings', () => {
    expect(
      contracts.MeetingSchema.safeParse({
        ...examples.Meeting,
        transport: { channelId: 'demo', threadTs: 1789200000.000001 },
      }).success,
    ).toBe(false);
  });
});

describe('configuration', () => {
  it('loads offline without credentials and explains missing live configuration', () => {
    expect(() => requireClickHouse(loadConfig({}))).toThrow(
      'Set CLICKHOUSE_URL',
    );
  });
  it('rejects unsafe database identifiers and URL credentials without echoing secrets', () => {
    expect(() =>
      loadConfig({ CLICKHOUSE_DATABASE: 'secret; DROP DATABASE drii' }),
    ).toThrow('Invalid configuration fields: CLICKHOUSE_DATABASE');
    expect(() =>
      requireClickHouse(
        loadConfig({ CLICKHOUSE_URL: 'https://user:secret@example.com' }),
      ),
    ).toThrow('configure user, password and database separately');
  });
});
