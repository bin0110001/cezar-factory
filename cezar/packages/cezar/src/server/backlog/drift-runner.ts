import { impactSnapshot, reconcileActualImpact } from '../../workspace/lifecycle.ts';
import { analyzeOverlap } from '../impact/overlap.ts';
import type { ManifestStore } from '../impact/manifest-store.ts';
import { evaluateDrift, type DriftDecision, type DriftPolicy, DEFAULT_DRIFT_POLICY } from './drift.ts';

/**
 * Gathers live facts for one in-flight issue (workspace registry, git, manifests) and asks the pure
 * drift policy what to do (#200). It only decides; replanning and human escalation are the caller's.
 */
export async function evaluateIssueDrift(options: {
  root: string; repository: string; issue: number; manifests: Pick<ManifestStore, 'get'>;
  /** Current head of the target branch; null = unknown (treated as drifted). */
  currentBaseSha: string | null;
  replansSoFar?: number; lastReplanAt?: string | null; policy?: DriftPolicy; now?: number; home?: string;
}): Promise<DriftDecision & { unpredicted: string[] }> {
  const now = options.now ?? Date.now();
  const mine = options.manifests.get(options.repository, options.issue);
  const [reconciliation, snapshot] = await Promise.all([
    reconcileActualImpact({ issue: String(options.issue), cwd: options.root, now, ...(options.home ? { home: options.home } : {}) }),
    impactSnapshot({ cwd: options.root, now, ...(options.home ? { home: options.home } : {}) }),
  ]);
  const entry = snapshot.entries.find((e) => e.issue === String(options.issue));
  let newOverlap: 'none' | 'module' | 'file' | 'contract' | 'unknown' = 'none';
  if (snapshot.overlaps.some((o) => o.issues.includes(String(options.issue)))) newOverlap = 'file';
  else if (mine) {
    // Manifest-level check against other live claims that have manifests.
    for (const other of snapshot.entries) {
      if (other.issue === String(options.issue) || other.leaseExpired) continue;
      const theirs = options.manifests.get(options.repository, Number(other.issue));
      const level = theirs ? analyzeOverlap(mine, theirs).level : 'unknown';
      if (level === 'file' || level === 'contract') { newOverlap = level; break; }
      if (level === 'unknown' && newOverlap === 'none') newOverlap = 'unknown';
    }
  }
  const decision = evaluateDrift({
    admittedBaseSha: mine?.repo.baseSha ?? entry?.baseSha ?? '', currentBaseSha: options.currentBaseSha,
    leaseExpired: entry?.leaseExpired ?? true, reservation: reconciliation.reservation, unpredictedFiles: reconciliation.reservation === 'none' ? [] : reconciliation.unpredicted,
    newOverlap, replansSoFar: options.replansSoFar ?? 0, lastReplanAt: options.lastReplanAt ?? null, now: new Date(now).toISOString(),
  }, options.policy ?? DEFAULT_DRIFT_POLICY);
  return { ...decision, unpredicted: reconciliation.reservation === 'none' ? [] : reconciliation.unpredicted };
}
