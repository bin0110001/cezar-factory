/**
 * Pilot metrics (#202): measurable accuracy of conflict prediction, merge debt and throughput,
 * computed from recorded facts only. Pure, so pilots in cezar-factory and TableFlux report the
 * same numbers from the same events.
 */
export interface PredictionSample {
  issue: string;
  predicted: string[];
  actual: string[];
}

export interface PredictionAccuracy {
  samples: number;
  /** Fraction of predicted files that were actually touched. null when nothing was predicted. */
  precision: number | null;
  /** Fraction of actually touched files that had been predicted. null when nothing was touched. */
  recall: number | null;
  falseNegatives: number;
  falsePositives: number;
}

const key = (p: string) => p.toLowerCase();

export function predictionAccuracy(samples: PredictionSample[]): PredictionAccuracy {
  let tp = 0, predictedTotal = 0, actualTotal = 0;
  for (const s of samples) {
    const actual = new Set(s.actual.map(key));
    const predicted = new Set(s.predicted.map(key));
    predictedTotal += predicted.size; actualTotal += actual.size;
    for (const p of predicted) if (actual.has(p)) tp++;
  }
  const r = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 1000);
  return { samples: samples.length, precision: r(tp, predictedTotal), recall: r(tp, actualTotal), falseNegatives: actualTotal - tp, falsePositives: predictedTotal - tp };
}

export interface PairOutcome {
  /** What the analyzer predicted for the pair. */
  predicted: 'none' | 'unknown' | 'module' | 'file' | 'contract';
  /** Whether the two branches actually conflicted at merge time. */
  actualConflict: boolean;
}

/** Confusion matrix for "predicted file/contract overlap" vs. real merge conflicts. `unknown` is reported apart, never counted as a safe "none". */
export function conflictConfusion(pairs: PairOutcome[]): { truePositive: number; falsePositive: number; falseNegative: number; trueNegative: number; unknown: number; recall: number | null; precision: number | null } {
  let tp = 0, fp = 0, fn = 0, tn = 0, unknown = 0;
  for (const p of pairs) {
    if (p.predicted === 'unknown') { unknown++; continue; }
    const positive = p.predicted === 'file' || p.predicted === 'contract';
    if (positive && p.actualConflict) tp++;
    else if (positive) fp++;
    else if (p.actualConflict) fn++;
    else tn++;
  }
  const r = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 1000);
  return { truePositive: tp, falsePositive: fp, falseNegative: fn, trueNegative: tn, unknown, recall: r(tp, tp + fn), precision: r(tp, tp + fp) };
}

export interface RolloutSample {
  /** Count of unresolved integration obligations at sampling time. */
  openObligations: number;
  admitted: number;
  deferredForConflict: number;
  completed: number;
  windowHours: number;
}

/** Merge debt = obligations still open per completed item; throughput per hour; regressions against a baseline. */
export function rolloutSummary(current: RolloutSample, baseline?: RolloutSample): {
  mergeDebtPerCompleted: number | null; throughputPerHour: number | null; deferralRate: number | null;
  regression: { throughput: boolean; mergeDebt: boolean } | null;
} {
  const div = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 1000);
  const m = div(current.openObligations, current.completed);
  const t = div(current.completed, current.windowHours);
  const result = { mergeDebtPerCompleted: m, throughputPerHour: t, deferralRate: div(current.deferredForConflict, current.admitted + current.deferredForConflict), regression: null as null | { throughput: boolean; mergeDebt: boolean } };
  if (baseline) {
    const bm = div(baseline.openObligations, baseline.completed), bt = div(baseline.completed, baseline.windowHours);
    result.regression = { throughput: t !== null && bt !== null && t < bt * 0.9, mergeDebt: m !== null && bm !== null && m > bm * 1.25 };
  }
  return result;
}
