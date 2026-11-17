import type { CheckCategory, CheckDefinition, CheckResult, CheckStatus, TRIGGER_SOURCES } from './check-provider.js';
import { queryFindings, type FindingQuery, type NormalizedFinding } from './normalized-findings.js';

/**
 * Gate integration and independent check schedule (#619). Gates are keyed on
 * category, mandatory/optional and max age only: no provider name appears in
 * a verdict, so swapping a provider needs no release state machine change.
 * Scheduling returns checks that are due; it has no way to create a release
 * or regression candidate.
 */

export interface GateRequirement {
  category: CheckCategory;
  mandatory: boolean;
  /** A run older than this does not satisfy the gate. */
  maxAgeHours: number;
}

export interface CheckRunRecord {
  checkId: string;
  category: CheckCategory;
  result: CheckResult;
  sourceSha: string;
  finishedAt: string;
  findings: NormalizedFinding[];
}

export type GateReason = 'missing' | 'stale' | 'wrong-source' | 'not-passing';

export interface GateVerdict {
  category: CheckCategory;
  mandatory: boolean;
  satisfied: boolean;
  /** Worst contributing status; `unknown` when nothing usable ran. */
  status: CheckStatus;
  reasons: GateReason[];
}

export interface GateEvaluation {
  allowed: boolean;
  verdicts: GateVerdict[];
  /** Mandatory gates that block promotion. */
  blocking: CheckCategory[];
}

const RANK: Record<CheckStatus, number> = { error: 4, fail: 3, unknown: 2, warn: 1, pass: 0, 'not-applicable': 0 };
const OK: ReadonlySet<CheckStatus> = new Set(['pass', 'warn', 'not-applicable']);

export function evaluateGates(
  requirements: readonly GateRequirement[], records: readonly CheckRunRecord[], ctx: { sourceSha: string; now: Date },
): GateEvaluation {
  const verdicts = requirements.map((req): GateVerdict => {
    const inCategory = records.filter((r) => r.category === req.category);
    const reasons = new Set<GateReason>();
    const usable: CheckRunRecord[] = [];
    if (!inCategory.length) reasons.add('missing');
    for (const r of inCategory) {
      if (r.sourceSha !== ctx.sourceSha) { reasons.add('wrong-source'); continue; }
      if (ctx.now.getTime() - Date.parse(r.finishedAt) > req.maxAgeHours * 3_600_000 || Number.isNaN(Date.parse(r.finishedAt))) { reasons.add('stale'); continue; }
      usable.push(r);
      if (!OK.has(r.result.status)) reasons.add('not-passing');
    }
    if (!usable.length && inCategory.length) reasons.add(reasons.has('stale') ? 'stale' : 'wrong-source');
    const allNotApplicable = usable.length > 0 && usable.every((r) => r.result.status === 'not-applicable');
    const status = allNotApplicable ? 'not-applicable'
      : usable.length ? usable.reduce<CheckStatus>((w, r) => (RANK[r.result.status] > RANK[w] ? r.result.status : w), 'pass') : 'unknown';
    const satisfied = usable.length > 0 && usable.every((r) => OK.has(r.result.status));
    return { category: req.category, mandatory: req.mandatory, satisfied, status, reasons: [...reasons] };
  });
  const blocking = verdicts.filter((v) => v.mandatory && !v.satisfied).map((v) => v.category);
  return { allowed: blocking.length === 0, verdicts, blocking };
}

/** One findings query across every provider's records. */
export function queryRecordFindings(records: readonly CheckRunRecord[], q?: FindingQuery): NormalizedFinding[] {
  const byFingerprint = new Map<string, NormalizedFinding>();
  for (const r of records) for (const f of r.findings) if (!byFingerprint.has(f.fingerprint)) byFingerprint.set(f.fingerprint, f);
  return queryFindings([...byFingerprint.values()], q);
}

export type ScheduledTrigger = Exclude<(typeof TRIGGER_SOURCES)[number], 'pr-dev' | 'release-candidate'>;

export interface DueCheck { checkId: string; trigger: ScheduledTrigger }

/**
 * Checks due under a non-candidate trigger. `periodic-independent` is due when never run or older than
 * `maxAgeHours`; `manual` and `risk-event` are always due for checks that allow them. The result lists checks
 * only: scheduling cannot create a regression candidate, so a scheduled run never produces a second one.
 */
export function planDueChecks(
  definitions: readonly CheckDefinition[], lastRunAt: Readonly<Record<string, string>>, trigger: ScheduledTrigger, now: Date,
): DueCheck[] {
  return definitions
    .filter((d) => d.triggers.includes(trigger))
    .filter((d) => {
      if (trigger !== 'periodic-independent') return true;
      const at = lastRunAt[d.id];
      const last = at ? Date.parse(at) : NaN;
      const maxAge = (d.policy.maxAgeHours ?? 24) * 3_600_000;
      return Number.isNaN(last) || now.getTime() - last >= maxAge;
    })
    .map((d) => ({ checkId: d.id, trigger }));
}
