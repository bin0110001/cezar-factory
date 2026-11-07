/**
 * Performance-regression gate for verification (issue #110).
 *
 * Pure, dependency-free helpers: span recording with measured-completion semantics, environment
 * fingerprints, baseline matching, budget evaluation, and a performance result that is recorded
 * SEPARATELY from the functional verification status. Nothing here changes a VerificationRun's
 * functional status; callers attach the returned PerformanceResult beside it.
 */

export type PerformanceStatus = 'passed' | 'failed' | 'inconclusive';

export interface SpanBudget {
  /** Median of baseline-comparable samples may not exceed this many ms. */
  medianMs?: number;
  /** p95 may not exceed this many ms. */
  p95Ms?: number;
  /** Any single measured completion above this many ms fails (absolute budget). */
  absoluteMs?: number;
  /** Samples needed before median/p95 are trusted; fewer is inconclusive. Default 1. */
  minSamples?: number;
}

export interface PerformancePolicy {
  version: 1;
  /** Environment fingerprint fields that must match for a baseline to be comparable. */
  fingerprintFields: string[];
  spans: Record<string, SpanBudget>;
}

export type EnvironmentFingerprint = Record<string, string>;

export interface SpanMeasurement {
  name: string;
  /** Present only when the span was measured to completion. */
  durationMs?: number;
  completed: boolean;
  attempt: number;
  startedAtMs: number;
  endedAtMs?: number;
}

export interface Baseline {
  id: string;
  fingerprint: EnvironmentFingerprint;
  /** Duration samples (ms) per span name. */
  samples: Record<string, number[]>;
}

export type BaselineComparison =
  | { comparable: true; baselineId: string }
  | { comparable: false; baselineId?: string; reason: string; mismatched: string[] };

export interface SpanVerdict {
  span: string;
  status: PerformanceStatus;
  reasons: string[];
  /** Every attempt's measured duration, first attempt first. Never overwritten by retries. */
  attemptDurationsMs: number[];
  firstAttemptMs?: number;
  worstMs?: number;
  medianMs?: number;
  p95Ms?: number;
  budget: SpanBudget;
}

export interface PerformanceResult {
  /** Separate from the functional status. */
  status: PerformanceStatus;
  fingerprint: EnvironmentFingerprint;
  baseline: BaselineComparison | { comparable: false; reason: string; mismatched: [] } ;
  spans: SpanVerdict[];
  /** Raw measurements for diagnostics, including the first slow attempt of a retried operation. */
  measurements: SpanMeasurement[];
}

export type Clock = () => number;

/** Records named spans. A span only yields a duration when `end` is called for it. */
export class SpanRecorder {
  private readonly open = new Map<string, { startedAtMs: number; attempt: number }>();
  private readonly done: SpanMeasurement[] = [];
  private readonly attempts = new Map<string, number>();

  private readonly clock: Clock;

  constructor(clock: Clock = () => performance.now()) { this.clock = clock; }

  start(name: string): void {
    if (this.open.has(name)) throw new Error(`span ${name} already started`);
    const attempt = (this.attempts.get(name) ?? 0) + 1;
    this.attempts.set(name, attempt);
    this.open.set(name, { startedAtMs: this.clock(), attempt });
  }

  end(name: string): SpanMeasurement {
    const entry = this.open.get(name);
    if (!entry) throw new Error(`span ${name} was not started`);
    this.open.delete(name);
    const endedAtMs = this.clock();
    const durationMs = endedAtMs - entry.startedAtMs;
    if (!(durationMs >= 0)) throw new Error(`span ${name} has a negative duration`);
    const measurement: SpanMeasurement = {
      name, durationMs, completed: true, attempt: entry.attempt, startedAtMs: entry.startedAtMs, endedAtMs,
    };
    this.done.push(measurement);
    return measurement;
  }

  /** Abandoned spans are recorded WITHOUT a duration, so they can never satisfy a budget. */
  abort(name: string): void {
    const entry = this.open.get(name);
    if (!entry) return;
    this.open.delete(name);
    this.done.push({ name, completed: false, attempt: entry.attempt, startedAtMs: entry.startedAtMs });
  }

  /** Measurements so far; still-open spans are reported as incomplete (no duration). */
  snapshot(): SpanMeasurement[] {
    const pending = [...this.open].map(([name, e]): SpanMeasurement => ({
      name, completed: false, attempt: e.attempt, startedAtMs: e.startedAtMs,
    }));
    return [...this.done, ...pending];
  }
}

/** Compare a baseline to the current environment over the policy's required fields only. */
export function compareFingerprints(
  policy: Pick<PerformancePolicy, 'fingerprintFields'>,
  current: EnvironmentFingerprint,
  baseline: Baseline | undefined,
): BaselineComparison | { comparable: false; reason: string; mismatched: [] } {
  if (!baseline) return { comparable: false, reason: 'no baseline recorded', mismatched: [] };
  const mismatched = policy.fingerprintFields.filter((field) => {
    const a = current[field];
    const b = baseline.fingerprint[field];
    return a === undefined || b === undefined || a !== b;
  });
  if (mismatched.length > 0) {
    return {
      comparable: false,
      baselineId: baseline.id,
      reason: `baseline ${baseline.id} was recorded in a different environment (differs or missing: ${mismatched.join(', ')})`,
      mismatched,
    };
  }
  return { comparable: true, baselineId: baseline.id };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) throw new Error('percentile of empty sample');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

const rank: Record<PerformanceStatus, number> = { passed: 0, inconclusive: 1, failed: 2 };
const worse = (a: PerformanceStatus, b: PerformanceStatus): PerformanceStatus => (rank[b] > rank[a] ? b : a);

/**
 * Evaluate measurements against the policy. Rules:
 * - A budgeted span with no completed measurement is inconclusive, never passed.
 * - Any incomplete span makes the gate at best inconclusive.
 * - The absolute budget applies to EVERY attempt, so a slow first attempt still fails after a fast retry.
 * - Median/p95 use the current attempts plus baseline samples, but only when the baseline is comparable
 *   and enough samples exist; otherwise those checks are inconclusive (never a silent pass or fail).
 */
export function evaluatePerformance(input: {
  policy: PerformancePolicy;
  fingerprint: EnvironmentFingerprint;
  measurements: SpanMeasurement[];
  baseline?: Baseline;
}): PerformanceResult {
  const { policy, fingerprint, measurements, baseline } = input;
  const comparison = compareFingerprints(policy, fingerprint, baseline);
  const spans: SpanVerdict[] = [];
  let status: PerformanceStatus = 'passed';

  for (const [name, budget] of Object.entries(policy.spans)) {
    const mine = measurements.filter((m) => m.name === name).sort((a, b) => a.attempt - b.attempt);
    const attemptDurationsMs = mine.filter((m) => m.completed && m.durationMs !== undefined).map((m) => m.durationMs!);
    const reasons: string[] = [];
    let verdict: PerformanceStatus = 'passed';
    const raise = (s: PerformanceStatus, why: string) => { verdict = worse(verdict, s); reasons.push(why); };

    if (mine.some((m) => !m.completed)) raise('inconclusive', 'span was not measured to completion');
    if (attemptDurationsMs.length === 0) raise('inconclusive', 'no completed measurement');

    const worstMs = attemptDurationsMs.length ? Math.max(...attemptDurationsMs) : undefined;
    if (budget.absoluteMs !== undefined && worstMs !== undefined && worstMs > budget.absoluteMs) {
      raise('failed', `slowest attempt ${worstMs}ms exceeds absolute budget ${budget.absoluteMs}ms`);
    }

    let medianMs: number | undefined;
    let p95Ms: number | undefined;
    if (budget.medianMs !== undefined || budget.p95Ms !== undefined) {
      if (!comparison.comparable) {
        raise('inconclusive', `median/p95 not evaluated: ${comparison.reason}`);
      } else {
        const samples = [...(baseline?.samples[name] ?? []), ...attemptDurationsMs];
        if (samples.length < (budget.minSamples ?? 1) || samples.length === 0) {
          raise('inconclusive', `only ${samples.length} samples, need ${budget.minSamples ?? 1}`);
        } else {
          medianMs = percentile(samples, 50);
          p95Ms = percentile(samples, 95);
          if (budget.medianMs !== undefined && medianMs > budget.medianMs) raise('failed', `median ${medianMs}ms exceeds ${budget.medianMs}ms`);
          if (budget.p95Ms !== undefined && p95Ms > budget.p95Ms) raise('failed', `p95 ${p95Ms}ms exceeds ${budget.p95Ms}ms`);
        }
      }
    }

    status = worse(status, verdict);
    spans.push({
      span: name, status: verdict, reasons, attemptDurationsMs,
      firstAttemptMs: attemptDurationsMs[0], worstMs, medianMs, p95Ms, budget,
    });
  }

  // Measured spans the policy does not know about make the gate inconclusive (typo'd names must not pass).
  for (const name of new Set(measurements.map((m) => m.name))) {
    if (!(name in policy.spans)) status = worse(status, 'inconclusive');
  }

  return { status, fingerprint, baseline: comparison, spans, measurements };
}

/** Validate a parsed policies/performance.yaml. Returns a list of problems (empty = valid). */
export function validatePerformancePolicy(raw: unknown, knownSpans?: readonly string[]): string[] {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return ['policy must be an object'];
  const policy = raw as Record<string, unknown>;
  for (const key of Object.keys(policy)) {
    if (!['version', 'fingerprintFields', 'spans'].includes(key)) errors.push(`unknown key ${key}`);
  }
  if (policy.version !== 1) errors.push('version must be 1');
  const fields = policy.fingerprintFields;
  if (!Array.isArray(fields) || fields.length === 0 || fields.some((f) => typeof f !== 'string' || f.length === 0)) {
    errors.push('fingerprintFields must be a non-empty array of strings');
  }
  const spans = policy.spans;
  if (typeof spans !== 'object' || spans === null || Array.isArray(spans) || Object.keys(spans).length === 0) {
    errors.push('spans must be a non-empty object');
    return errors;
  }
  for (const [name, budget] of Object.entries(spans as Record<string, unknown>)) {
    if (knownSpans && !knownSpans.includes(name)) errors.push(`unknown span ${name}`);
    if (typeof budget !== 'object' || budget === null || Array.isArray(budget)) { errors.push(`span ${name}: budget must be an object`); continue; }
    const b = budget as Record<string, unknown>;
    for (const key of Object.keys(b)) {
      if (!['medianMs', 'p95Ms', 'absoluteMs', 'minSamples'].includes(key)) errors.push(`span ${name}: unknown key ${key}`);
    }
    if (b.medianMs === undefined && b.p95Ms === undefined && b.absoluteMs === undefined) {
      errors.push(`span ${name}: at least one of medianMs, p95Ms, absoluteMs is required`);
    }
    for (const key of ['medianMs', 'p95Ms', 'absoluteMs'] as const) {
      const v = b[key];
      if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v > 0)) errors.push(`span ${name}: ${key} must be a positive number`);
    }
    const ms = b.minSamples;
    if (ms !== undefined && !(typeof ms === 'number' && Number.isInteger(ms) && ms >= 1)) errors.push(`span ${name}: minSamples must be a positive integer`);
  }
  return errors;
}
