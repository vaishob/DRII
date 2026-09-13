import { z } from 'zod';
import type { Actor, Decision, Source } from '../contracts/index.js';
import type { SourceStore } from '../contracts/services.js';
import type { Records } from '../data/records.js';
import { DecisionQueue } from '../data/queue.js';
import { latestMetric } from '../data/metrics.js';
import { stableId, WorkflowError } from './workflow.js';

export const REVIEW_COOLDOWN_MS = 60_000;
const State = z.object({
  fingerprint: z.string(),
  muted: z.boolean(),
  dismissed: z.array(z.string()),
  lastAlertAt: z.number(),
  lastMessage: z.string(),
  controls: z.array(z.string()).default([]),
});
export interface Observation {
  assumptionId: string;
  assumption: string;
  sourceId: string | null;
  sourceTime: string | null;
  previousValue: number | null;
  value: number | null;
  unit: string | null;
  status: 'UNKNOWN' | 'HOLDS' | 'VIOLATED' | 'SUPERSEDED';
  condition: string;
}
const queue = new DecisionQueue();
export function conditionHolds(
  value: number,
  op: string,
  threshold: number,
): boolean {
  switch (op) {
    case 'LT':
      return value < threshold;
    case 'LTE':
      return value <= threshold;
    case 'EQ':
      return value === threshold;
    case 'GTE':
      return value >= threshold;
    case 'GT':
      return value > threshold;
    default:
      throw new Error('Unknown operator');
  }
}
export class AssumptionMonitor {
  constructor(
    private readonly sources: SourceStore,
    private readonly records: Records,
    private readonly now: () => number = Date.now,
    private readonly simulationLabel: string | null = null,
  ) {}
  private async state(d: Decision) {
    return (
      (await this.records.get(
        d.workspaceId,
        'review-state',
        d.decisionId,
        State,
      )) ?? {
        fingerprint: '',
        muted: false,
        dismissed: [],
        lastAlertAt: 0,
        lastMessage: '',
        controls: [],
      }
    );
  }
  async inspect(d: Decision, asOf: string): Promise<Observation[]> {
    const rows: Observation[] = [];
    const sourceCache = new Map<string, Source | null>();
    for (const assumption of d.assumptions.slice(0, 8)) {
      const sourceId = assumption.sourceIds[0] ?? null;
      if (sourceId && !sourceCache.has(sourceId))
        sourceCache.set(
          sourceId,
          await this.sources.getSource(
            d.workspaceId,
            d.projectId,
            sourceId,
            asOf,
          ),
        );
      const source = sourceId ? sourceCache.get(sourceId) : null;
      const current =
        source && assumption.metric
          ? latestMetric(source.metrics, assumption.metric.name, asOf)
          : null;
      const metric = current?.unit === assumption.metric?.unit ? current : null;
      const original = assumption.metric
        ? latestMetric(
            d.evidence
              .filter((e) => e.sourceId === sourceId)
              .flatMap((e) => e.metrics),
            assumption.metric.name,
            d.approval?.approvedAt ?? d.createdAt,
          )
        : null;
      const before =
        original?.unit === assumption.metric?.unit ? original : null;
      let status: Observation['status'] = 'UNKNOWN';
      if (metric && assumption.metric)
        status = conditionHolds(
          metric.value,
          assumption.metric.operator,
          assumption.metric.threshold,
        )
          ? 'HOLDS'
          : 'VIOLATED';
      const old = d.evidence.find((e) => e.sourceId === sourceId);
      if (
        !assumption.metric &&
        source &&
        old &&
        source.revision > old.sourceRevision &&
        !source.content.includes(old.excerpt)
      )
        status = 'SUPERSEDED';
      rows.push({
        assumptionId: assumption.assumptionId,
        assumption: assumption.text,
        sourceId,
        sourceTime: current?.measuredAt ?? source?.updatedAt ?? null,
        previousValue: before?.value ?? null,
        value: metric?.value ?? null,
        unit: assumption.metric?.unit ?? null,
        status,
        condition: assumption.metric
          ? `${assumption.metric.name} ${assumption.metric.operator} ${assumption.metric.threshold} ${assumption.metric.unit}`
          : 'Source content remains applicable',
      });
    }
    return rows;
  }
  async review(d: Decision): Promise<string> {
    if (d.state !== 'APPROVED')
      throw new WorkflowError(
        'Assumption monitoring starts after human approval.',
      );
    return queue.run(d.workspaceId, d.decisionId, async () => {
      const time = this.now();
      const asOf = new Date(time).toISOString();
      const observations = await this.inspect(d, asOf);
      const fingerprint = stableId(
        d.decisionId,
        String(d.revision),
        JSON.stringify(
          observations.map((o) => [o.assumptionId, o.status, o.condition]),
        ),
      );
      const snapshot = {
        decisionId: d.decisionId,
        approvedRevision: d.revision,
        measuredAt: asOf,
        simulationLabel: this.simulationLabel,
        observations,
      };
      await this.records.put(
        d.workspaceId,
        'assumption-snapshot',
        `${d.decisionId}:${asOf}`,
        snapshot,
      );
      const state = await this.state(d);
      const changed = observations.filter(
        (o) => o.status === 'VIOLATED' || o.status === 'SUPERSEDED',
      );
      const detail = observations
        .map(
          (o) =>
            `${o.status}: ${o.assumption}\n${o.condition}; before ${o.previousValue ?? 'unknown'} → now ${o.value ?? 'unknown'} ${o.unit ?? ''}; source ${o.sourceId ?? 'unavailable'} at ${o.sourceTime ?? 'unknown'}`,
        )
        .join('\n');
      const message = changed.length
        ? `Review suggested for ${changed.length} decision-critical condition(s).\n${detail}\nApproved option: ${d.approval?.optionId ?? 'unknown'}. Actions to re-check: ${d.actions.map((a) => a.actionId).join(', ') || 'not specified'}. Should the owner start a new review given this change? The approved revision remains unchanged.`
        : `No observed violation. ${observations.filter((o) => o.status === 'UNKNOWN').length} assumption(s) remain unknown.\n${detail}`;
      const notify =
        changed.length > 0 &&
        state.fingerprint !== fingerprint &&
        !state.muted &&
        !state.dismissed.includes(fingerprint) &&
        (state.lastAlertAt === 0 ||
          time - state.lastAlertAt >= REVIEW_COOLDOWN_MS);
      if (notify)
        await this.records.put(
          d.workspaceId,
          'review-event',
          `${d.decisionId}:${fingerprint}`,
          {
            ...snapshot,
            eventType: 'REVIEW_NEEDED',
            fingerprint,
            reason: message,
          },
        );
      await this.records.put(d.workspaceId, 'review-state', d.decisionId, {
        ...state,
        fingerprint:
          notify ||
          !changed.length ||
          state.muted ||
          state.dismissed.includes(fingerprint)
            ? fingerprint
            : state.fingerprint,
        lastAlertAt: notify ? time : state.lastAlertAt,
        lastMessage: message,
      });
      return `${notify ? 'New review-needed event recorded.\n' : state.muted ? 'Reviews are muted.\n' : ''}${message}`;
    });
  }
  async mute(d: Decision, actor: Actor, deliveryId?: string): Promise<string> {
    if (actor.actorId !== d.owner.actorId)
      throw new WorkflowError(
        'Only the decision owner can change review notifications.',
      );
    return queue.run(d.workspaceId, d.decisionId, async () => {
      const state = await this.state(d);
      const control = deliveryId ? stableId(actor.actorId, deliveryId) : null;
      if (control && state.controls.includes(control))
        return state.muted
          ? 'Assumption reviews muted.'
          : 'Assumption reviews unmuted.';
      await this.records.put(d.workspaceId, 'review-state', d.decisionId, {
        ...state,
        muted: !state.muted,
        controls: control
          ? [...state.controls, control].slice(-100)
          : state.controls,
        fingerprint: state.muted ? '' : state.fingerprint,
      });
      return state.muted
        ? 'Assumption reviews unmuted.'
        : 'Assumption reviews muted. Review now still shows current measurements.';
    });
  }
  async dismiss(d: Decision, actor: Actor): Promise<string> {
    if (actor.actorId !== d.owner.actorId)
      throw new WorkflowError('Only the decision owner can dismiss a review.');
    return queue.run(d.workspaceId, d.decisionId, async () => {
      const state = await this.state(d);
      await this.records.put(d.workspaceId, 'review-state', d.decisionId, {
        ...state,
        dismissed: [...new Set([...state.dismissed, state.fingerprint])].slice(
          -20,
        ),
      });
      return 'This observed condition was dismissed. New condition changes may still suggest a review.';
    });
  }
}
