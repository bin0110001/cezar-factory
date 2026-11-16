import type { NormalizedFinding } from './normalized-findings.js';

export interface Reconciliation {
  /** In this run, not in the previous open set. */
  opened: NormalizedFinding[];
  /** In both runs. */
  stillOpen: NormalizedFinding[];
  /** Open before and absent now. Only produced when the new run is `complete`. */
  fixed: NormalizedFinding[];
}

/**
 * Reconcile consecutive runs of the same check by common fingerprint. A run that did not complete
 * (error/unknown, stale feed) cannot fix anything: absence from an unusable run is not evidence.
 */
export function reconcileRuns(previousOpen: readonly NormalizedFinding[], current: readonly NormalizedFinding[], complete: boolean): Reconciliation {
  const prev = new Map(previousOpen.map((f) => [f.fingerprint, f]));
  const cur = new Map(current.map((f) => [f.fingerprint, f]));
  return {
    opened: [...cur.values()].filter((f) => !prev.has(f.fingerprint)),
    stillOpen: [...cur.values()].filter((f) => prev.has(f.fingerprint)),
    fixed: complete ? [...prev.values()].filter((f) => !cur.has(f.fingerprint)) : [],
  };
}
