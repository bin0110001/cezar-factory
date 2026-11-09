/**
 * Dynamic impact drift (#200): decide, deterministically, what to do when reality moves away from
 * the manifest the scheduler admitted. Pure; callers feed it facts from the workspace registry
 * (#197) and git, and act on the returned decision. Replanning is bounded so a flapping branch
 * cannot loop forever.
 */
export type DriftSignal = 'base-advanced' | 'lease-expired' | 'unpredicted-files' | 'manifest-expired' | 'new-overlap';
export type DriftAction = 'none' | 'recheck-conflicts' | 'replan' | 'pause-for-human';

export interface DriftFacts {
  admittedBaseSha: string;
  currentBaseSha: string | null;
  leaseExpired: boolean;
  reservation: 'active' | 'expired' | 'none';
  unpredictedFiles: string[];
  /** Overlap level against OTHER live work that did not exist at admission. */
  newOverlap: 'none' | 'module' | 'file' | 'contract' | 'unknown';
  replansSoFar: number;
  /** Time of the last replan, to enforce a cooldown. */
  lastReplanAt?: string | null;
  now: string;
}

export interface DriftPolicy {
  maxReplans: number;
  cooldownMs: number;
  /** Unpredicted files at or above this count trigger a replan (below it: a recheck). */
  replanUnpredictedAt: number;
}
export const DEFAULT_DRIFT_POLICY: DriftPolicy = { maxReplans: 2, cooldownMs: 10 * 60_000, replanUnpredictedAt: 3 };

export interface DriftDecision { action: DriftAction; signals: DriftSignal[]; reasons: string[]; replanAllowed: boolean }

export function evaluateDrift(f: DriftFacts, policy: DriftPolicy = DEFAULT_DRIFT_POLICY): DriftDecision {
  const signals: DriftSignal[] = [];
  const reasons: string[] = [];
  const advanced = f.currentBaseSha !== null && !(f.admittedBaseSha.startsWith(f.currentBaseSha) || f.currentBaseSha.startsWith(f.admittedBaseSha));
  if (advanced) { signals.push('base-advanced'); reasons.push('target branch advanced since admission'); }
  if (f.leaseExpired) { signals.push('lease-expired'); reasons.push('workspace lease expired'); }
  if (f.reservation !== 'active') { signals.push('manifest-expired'); reasons.push(f.reservation === 'none' ? 'no impact reservation recorded' : 'impact reservation expired'); }
  if (f.unpredictedFiles.length > 0) { signals.push('unpredicted-files'); reasons.push(`${f.unpredictedFiles.length} changed file(s) were not predicted`); }
  if (f.newOverlap !== 'none' && f.newOverlap !== 'module') { signals.push('new-overlap'); reasons.push(`new ${f.newOverlap} overlap with other live work`); }

  if (signals.length === 0) return { action: 'none', signals, reasons: ['no drift'], replanAllowed: true };

  const cooling = f.lastReplanAt ? Date.parse(f.now) - Date.parse(f.lastReplanAt) < policy.cooldownMs : false;
  const replanAllowed = f.replansSoFar < policy.maxReplans && !cooling;
  const wantsReplan = signals.includes('base-advanced') || f.unpredictedFiles.length >= policy.replanUnpredictedAt || f.newOverlap === 'file' || f.newOverlap === 'contract';
  if (wantsReplan) {
    if (replanAllowed) return { action: 'replan', signals, reasons, replanAllowed };
    return { action: 'pause-for-human', signals, reasons: [...reasons, f.replansSoFar >= policy.maxReplans ? `replan budget (${policy.maxReplans}) exhausted` : 'replan cooldown active'], replanAllowed };
  }
  // an expired lease alone never silently continues: re-verify ownership and conflicts first
  return { action: 'recheck-conflicts', signals, reasons, replanAllowed };
}
