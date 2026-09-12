import { z } from 'zod';
import {
  DecisionEventSchema,
  MeetingSchema,
  SourceSchema,
  type DecisionEvent,
  type Meeting,
  type EvidenceScope,
} from '../src/contracts/index.js';
import type {
  DecisionStore,
  SourceStore,
  EvidenceRetriever,
} from '../src/contracts/services.js';
import type { Records } from '../src/data/records.js';
import type { ReasoningModel } from '../src/intelligence/model.js';
import {
  ExtractionSchema,
  type Extraction,
  type Review,
} from '../src/intelligence/schema.js';
import sourceInputs from '../fixtures/demo/sources.json' with { type: 'json' };

// Explicit offline adapters. Never imported by production entrypoints.
export class MemoryRecords implements Records {
  readonly rows = new Map<string, unknown>();
  async get<T>(w: string, n: string, k: string, schema: z.ZodType<T>) {
    const raw = this.rows.get(JSON.stringify([w, n, k]));
    return raw === undefined ? null : schema.parse(structuredClone(raw));
  }
  async put(w: string, n: string, k: string, v: unknown) {
    this.rows.set(JSON.stringify([w, n, k]), structuredClone(v));
  }
}
export class MemoryDecisions implements DecisionStore {
  constructor(readonly records: Records) {}
  async ingestMeeting(m: Meeting) {
    await this.records.put(m.workspaceId, 'meeting', m.meetingId, m);
  }
  async getMeeting(w: string, id: string) {
    return this.records.get(w, 'meeting', id, MeetingSchema);
  }
  async getDecision(w: string, id: string) {
    return (
      (await this.records.get(w, 'decision', id, DecisionEventSchema))
        ?.decision ?? null
    );
  }
  async getEventByDeduplicationId(w: string, id: string, d: string) {
    return this.records.get(w, 'event', `${id}:${d}`, DecisionEventSchema);
  }
  async appendDecisionEvent(e: DecisionEvent) {
    const parsed = DecisionEventSchema.parse(e);
    const current = await this.getDecision(e.workspaceId, e.decisionId);
    if (current && current.revision >= e.revision)
      throw new Error('Duplicate revision');
    await this.records.put(
      e.workspaceId,
      'event',
      `${e.decisionId}:${e.deduplicationId}`,
      parsed,
    );
    await this.records.put(e.workspaceId, 'decision', e.decisionId, parsed);
  }
}
export class DemoSources implements SourceStore, EvidenceRetriever {
  sources = sourceInputs.map((s) => SourceSchema.parse(s));
  fail = false;
  async ingestSource(input: unknown) {
    this.sources.push(SourceSchema.parse(input));
  }
  async getSource(w: string, p: string, id: string, at: string) {
    const s = this.sources
      .filter(
        (s) =>
          s.workspaceId === w &&
          s.projectId === p &&
          s.sourceId === id &&
          Date.parse(s.availableAt) <= Date.parse(at) &&
          Date.parse(s.updatedAt) <= Date.parse(at),
      )
      .sort((a, b) => b.revision - a.revision)[0];
    return s?.visibility === 'WORKSPACE' ? s : null;
  }
  async retrieveEvidence(
    _q: string,
    scope: EvidenceScope,
  ): ReturnType<EvidenceRetriever['retrieveEvidence']> {
    if (this.fail)
      return {
        status: 'FAILED',
        evidence: [],
        code: 'DATABASE_ERROR',
        retryable: true,
      };
    const visible = (
      await Promise.all(
        [...new Set(this.sources.map((s) => s.sourceId))].map((id) =>
          this.getSource(scope.workspaceId, scope.projectId, id, scope.asOf),
        ),
      )
    ).filter((s) => s !== null);
    return {
      status: 'FOUND',
      evidence: visible.map((s) => ({
        schemaVersion: '1.0',
        workspaceId: scope.workspaceId,
        decisionId: scope.decisionId,
        revision: scope.revision,
        createdAt: scope.asOf,
        sourceIds: [s.sourceId],
        evidenceId: `${s.sourceId}-${s.revision}`,
        sourceId: s.sourceId,
        sourceRevision: s.revision,
        chunkId: `${s.sourceId}-chunk`,
        excerpt: s.content,
        sourceTitle: s.title,
        sourceType: s.sourceType,
        sourceDate: s.updatedAt,
        sourceUrl: s.url,
        owner: s.owner,
        synthetic: true,
        metrics: s.metrics,
        relevance: { method: 'KEYWORD', score: 1, model: null },
      })),
    };
  }
}
export class ScriptedModel implements ReasoningModel {
  readonly name = 'SCRIPTED-OFFLINE-NOT-A-MODEL';
  async generate<T>(
    stage: string,
    schema: z.ZodType<T>,
    _instruction: string,
    data: unknown,
    validate: (r: T) => void,
  ): Promise<T> {
    let result: unknown;
    if (stage === 'decision_extraction') {
      const m = MeetingSchema.parse(
        z.object({ meeting: z.unknown() }).parse(data).meeting,
      );
      const segment =
        m.segments.find((s) => /blocking bugs/.test(s.text)) ?? m.segments[0]!;
      const noDecision = !m.segments.some((s) =>
        /decid|launch|pilot/i.test(s.text),
      );
      result = {
        summary: 'SCRIPTED OFFLINE: launch review',
        question: noDecision ? null : 'Broad launch or limited pilot?',
        options: noDecision
          ? []
          : [
              {
                id: 'pilot',
                title: 'Limited pilot',
                description: 'Billing disabled',
              },
              {
                id: 'broad',
                title: 'Broad launch',
                description: 'All customers',
              },
            ],
        claims: noDecision
          ? []
          : [
              {
                id: 'blockers',
                text: 'All blocking bugs are fixed',
                references: [
                  { segmentId: segment.segmentId, quote: segment.text },
                ],
              },
            ],
        priorities: [],
        disagreements: [],
        clarification: noDecision
          ? 'What decision should the team make?'
          : null,
      } satisfies Extraction;
    } else {
      const input = z
        .object({
          extraction: ExtractionSchema,
          evidence: z.array(
            z.object({
              evidenceId: z.string(),
              sourceId: z.string(),
              excerpt: z.string(),
              metrics: z.array(
                z.object({ name: z.string(), value: z.number() }),
              ),
            }),
          ),
          attributedReplies: z.array(z.unknown()),
        })
        .parse(data);
      const qa = input.evidence.find(
        (e) => e.sourceId === 'engineering-readiness',
      );
      const bugs = qa?.metrics.find((m) => m.name === 'blocking_bugs')?.value;
      const conflicting = input.evidence.find(
        (e) => e.sourceId === 'engineering-counter-report',
      );
      const answered = input.attributedReplies.length > 0;
      result = {
        checks: input.extraction.claims.map((c) => ({
          claimId: c.id,
          status:
            qa && bugs !== undefined && !conflicting
              ? bugs === 0
                ? 'SUPPORTED'
                : 'CONTRADICTED'
              : 'INSUFFICIENT_EVIDENCE',
          explanation: conflicting
            ? 'Equally dated QA reports conflict; the blocker status needs verification.'
            : qa
              ? `Measured blockers: ${bugs ?? 'unknown'}.`
              : 'No evidence was available.',
          citations: qa
            ? [{ evidenceId: qa.evidenceId, quote: qa.excerpt }]
            : [],
        })),
        objection: {
          text:
            bugs === 0
              ? 'Support coverage still needs verification.'
              : 'Unresolved engineering blockers challenge broad launch.',
          citations: qa
            ? [{ evidenceId: qa.evidenceId, quote: qa.excerpt }]
            : [],
          wouldChangeAssessment: 'Verified fixes and support coverage.',
        },
        additionalQueries: [],
        comparison: input.extraction.options.map((o) => ({
          optionId: o.id,
          assessment:
            o.id === 'pilot'
              ? 'Conditional on coverage'
              : bugs === 0
                ? 'Engineering condition satisfied'
                : 'Engineering condition unsatisfied',
        })),
        recommendation: {
          optionId: 'pilot',
          conditions: [
            answered
              ? 'Attributed Support reply received; verify coverage before rollout.'
              : 'Ask Support about coverage.',
          ],
        },
        question: answered
          ? null
          : { text: 'Can Support cover a limited pilot?', role: 'Support' },
        actions: [
          {
            id: 'verify',
            description: 'Verify coverage and disable billing',
            dependsOn: [],
            proposedOwner: null,
            dueAt: null,
          },
        ],
        assumptions: [
          {
            id: 'capacity',
            text: 'Two support agents remain available',
            sourceId: input.evidence.some(
              (e) => e.sourceId === 'support-capacity',
            )
              ? 'support-capacity'
              : null,
            metricName: 'available_agents',
            operator: 'GTE',
            threshold: 2,
            unit: 'people',
            proposedOwner: null,
            reviewAt: null,
          },
        ],
      } satisfies Review;
    }
    const parsed = schema.parse(result);
    validate(parsed);
    return parsed;
  }
}
