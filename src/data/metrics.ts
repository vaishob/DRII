import type { Source } from '../contracts/index.js';

type Metric = Source['metrics'][number];
// Source records may carry measurement history in any order. A changed unit
// belongs to the newest measurement; an older compatible unit is not current.
export function latestMetric(
  metrics: Metric[],
  name: string,
  asOf: string,
): Metric | null {
  const time = Date.parse(asOf);
  const eligible = metrics.filter(
    (metric) => metric.name === name && Date.parse(metric.measuredAt) <= time,
  );
  const latestTime = Math.max(
    ...eligible.map((metric) => Date.parse(metric.measuredAt)),
  );
  const latest = eligible.filter(
    (metric) => Date.parse(metric.measuredAt) === latestTime,
  );
  const value = latest[0];
  if (
    !value ||
    latest.some(
      (metric) => metric.value !== value.value || metric.unit !== value.unit,
    )
  )
    return null;
  return value;
}
