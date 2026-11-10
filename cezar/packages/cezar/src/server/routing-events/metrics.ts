import type { RoutingEvent } from './event.ts';

export type MetricValue = { value: number | null; samples: number };
export type RoutingMetrics = {
  utilization: MetricValue;
  blockedDurationMs: MetricValue;
  fallbackFrequency: MetricValue;
  successByTier: Record<string, { successes: number; failures: number; rate: number | null; samples: number }>;
  forecastConfidence: MetricValue;
};

/** Pure projection over an already-redacted event history. Missing evidence is represented as null. */
export function computeRoutingMetrics(input: readonly RoutingEvent[]): RoutingMetrics {
  const events = [...input].sort((a, b) => a.sequence - b.sequence || a.timestamp.localeCompare(b.timestamp));
  const seen = new Set<string>();
  const unique = events.filter((event) => {
    const key = event.eventId ?? `sequence:${event.sequence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const mean = (values: number[]): MetricValue => ({ value: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, samples: values.length });
  const ratios = unique.flatMap((e) => {
    const q = e.quotaSnapshot;
    const ratio = q?.ratio ?? (q?.limit && q.used !== undefined ? q.used / q.limit : undefined);
    return ratio !== undefined && Number.isFinite(ratio) && ratio >= 0 ? [ratio] : [];
  });
  const confidences = unique.flatMap((e) => e.forecastConfidence === undefined ? [] : [e.forecastConfidence]);
  const groups = new Map<string, RoutingEvent[]>();
  for (const e of unique) {
    if (!e.runId && !e.attemptId) continue;
    const key = `${e.runId ?? ''}\0${e.attemptId ?? e.attempt}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const blocked: number[] = [];
  const outcomes = new Map<string, { successes: number; failures: number }>();
  for (const group of groups.values()) {
    group.sort((a, b) => a.sequence - b.sequence);
    for (let i = 0; i < group.length; i++) {
      const e = group[i]!;
      if (e.state === 'capacity-blocked') {
        const next = group.slice(i + 1).find((x) => x.timestamp >= e.timestamp);
        if (next) {
          const duration = Date.parse(next.timestamp) - Date.parse(e.timestamp);
          if (Number.isFinite(duration) && duration >= 0) blocked.push(duration);
        }
      }
    }
    const terminal = [...group].reverse().find((e) => e.state === 'completed' || e.state === 'failed');
    if (terminal) {
      const tier = terminal.selected?.tier ?? [...group].reverse().find((e) => e.sequence <= terminal.sequence && e.selected?.tier)?.selected?.tier;
      if (tier) {
        const count = outcomes.get(tier) ?? { successes: 0, failures: 0 };
        if (terminal.state === 'completed') count.successes++; else count.failures++;
        outcomes.set(tier, count);
      }
    }
  }
  const decisions = unique.filter((e) => e.state === 'routed' && e.fallback !== undefined);
  const tiers = Object.fromEntries([...outcomes].sort(([a], [b]) => a.localeCompare(b)).map(([tier, count]) => {
    const samples = count.successes + count.failures;
    return [tier, { ...count, rate: samples ? count.successes / samples : null, samples }];
  }));
  return {
    utilization: mean(ratios),
    blockedDurationMs: mean(blocked),
    fallbackFrequency: mean(decisions.map((e) => e.fallback ? 1 : 0)),
    successByTier: tiers,
    forecastConfidence: mean(confidences),
  };
}
