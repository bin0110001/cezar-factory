import { z } from 'zod';
import type { NormalizedFinding, Severity } from './normalized-findings.js';

/**
 * Severity separation, baselines, trend and reviewed suppressions for normalized findings (#650, #651).
 *
 * A new security finding at or above the configured severity blocks. Existing (baselined) debt stays visible but never blocks.
 * Quality debt (style, complexity, warnings) is reported on its own and blocks only if the policy explicitly says so. A
 * suppression or path exclusion works only if a human or operator reviewed it and it has not expired; an unreviewed one is
 * ignored and an expired one blocks again.
 */

const SEV = ['info', 'low', 'medium', 'high', 'critical'] as const;
const rank = (s: Severity) => SEV.indexOf(s);
const DAY = 86_400_000;

export const baselineEntrySchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  class: z.enum(['security', 'quality-debt']),
  severity: z.enum(SEV),
  addedAt: z.string().datetime(),
  acknowledgedBy: z.string().min(1).max(128).optional(),
}).strict();
export type BaselineEntry = z.infer<typeof baselineEntrySchema>;

export const suppressionSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  ruleId: z.string().min(1).max(256).optional(),
  pathGlob: z.string().min(1).max(512).optional(),
  reason: z.string().min(1).max(500),
  /** Both are required for the suppression to count: it is reviewed or it is ignored. */
  reviewedBy: z.string().min(1).max(128).optional(),
  reviewerKind: z.enum(['human', 'operator', 'agent']).optional(),
  reviewedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime(),
  receiptId: z.string().min(1).max(128).optional(),
}).strict().refine((s) => Boolean(s.fingerprint || s.ruleId || s.pathGlob), { message: 'a suppression needs a fingerprint, rule id or path scope (no blanket waivers)' });
export type Suppression = z.infer<typeof suppressionSchema>;

export const pathExclusionSchema = z.object({
  glob: z.string().min(1).max(512),
  reason: z.string().min(1).max(500),
  reviewedBy: z.string().min(1).max(128).optional(),
  reviewerKind: z.enum(['human', 'operator', 'agent']).optional(),
  reviewedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime(),
}).strict();
export type PathExclusion = z.infer<typeof pathExclusionSchema>;

export interface FindingGatePolicy {
  /** New security findings at or above this severity block. Default `high`. */
  blockSecurityAt: Severity;
  /** New quality debt blocks only when set (default off: debt is visible, not a blocker). */
  blockQualityDebtAt?: Severity | undefined;
  /** Baseline entries older than this stop protecting a finding. */
  baselineMaxAgeDays?: number | undefined;
}

export const DEFAULT_FINDING_POLICY: FindingGatePolicy = { blockSecurityAt: 'high', baselineMaxAgeDays: 90 };

const globToRegex = (glob: string): RegExp => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '[^/]')}$`);
const matchGlob = (glob: string, path: string | undefined): boolean => path !== undefined && globToRegex(glob).test(path.replace(/\\/g, '/'));

export type ReviewProblem = 'unreviewed' | 'agent-reviewed' | 'expired';

/** Why a suppression or exclusion does not count. Only a human or operator review counts. */
export function reviewProblems(item: { reviewedBy?: string | undefined; reviewerKind?: string | undefined; expiresAt: string }, now: Date): ReviewProblem[] {
  const out: ReviewProblem[] = [];
  if (!item.reviewedBy || !item.reviewerKind) out.push('unreviewed');
  else if (item.reviewerKind !== 'human' && item.reviewerKind !== 'operator') out.push('agent-reviewed');
  if (now.getTime() >= Date.parse(item.expiresAt)) out.push('expired');
  return out;
}

export interface Diff { added: NormalizedFinding[]; existing: NormalizedFinding[]; fixed: BaselineEntry[] }

/** New / still-present / fixed relative to the baseline, by the provider-independent fingerprint. A stale baseline entry no longer protects. */
export function diffAgainstBaseline(findings: readonly NormalizedFinding[], baseline: readonly BaselineEntry[], opts: { now: Date; maxAgeDays?: number | undefined }): Diff {
  const live = new Map<string, BaselineEntry>();
  for (const b of baseline) {
    if (opts.maxAgeDays !== undefined && opts.now.getTime() - Date.parse(b.addedAt) > opts.maxAgeDays * DAY) continue;
    live.set(b.fingerprint, b);
  }
  const current = new Set(findings.map((f) => f.fingerprint));
  return {
    added: findings.filter((f) => !live.has(f.fingerprint)),
    existing: findings.filter((f) => live.has(f.fingerprint)),
    fixed: baseline.filter((b) => !current.has(b.fingerprint)),
  };
}

export type FindingStatus = 'new' | 'existing' | 'suppressed' | 'excluded';
export interface FindingVerdict { fingerprint: string; class: NormalizedFinding['class']; severity: Severity; status: FindingStatus; blocking: boolean; reasons: string[] }
export interface FindingGateResult { blocked: boolean; blocking: string[]; verdicts: FindingVerdict[]; visibleDebt: { security: number; qualityDebt: number } }

export function evaluateFindingGate(input: {
  findings: readonly NormalizedFinding[]; baseline: readonly BaselineEntry[]; suppressions?: readonly Suppression[]; exclusions?: readonly PathExclusion[];
  policy?: FindingGatePolicy; now: Date;
}): FindingGateResult {
  const policy = input.policy ?? DEFAULT_FINDING_POLICY;
  const diff = diffAgainstBaseline(input.findings, input.baseline, { now: input.now, maxAgeDays: policy.baselineMaxAgeDays });
  const isExisting = new Set(diff.existing.map((f) => f.fingerprint));
  const verdicts: FindingVerdict[] = input.findings.map((f): FindingVerdict => {
    const reasons: string[] = [];
    let status: FindingStatus = isExisting.has(f.fingerprint) ? 'existing' : 'new';
    for (const ex of input.exclusions ?? []) {
      if (!matchGlob(ex.glob, f.path)) continue;
      const problems = reviewProblems(ex, input.now);
      if (problems.length === 0) { status = 'excluded'; reasons.push(`path excluded by ${ex.glob} (${ex.reviewedBy})`); break; }
      reasons.push(`path exclusion ${ex.glob} ignored: ${problems.join(', ')}`);
    }
    if (status !== 'excluded') {
      for (const s of input.suppressions ?? []) {
        const matches = (!s.fingerprint || s.fingerprint === f.fingerprint) && (!s.ruleId || s.ruleId === f.ruleId) && (!s.pathGlob || matchGlob(s.pathGlob, f.path));
        if (!matches) continue;
        const problems = reviewProblems(s, input.now);
        if (problems.length === 0) { status = 'suppressed'; reasons.push(`suppressed until ${s.expiresAt} by ${s.reviewedBy}`); break; }
        reasons.push(`suppression ignored: ${problems.join(', ')}`);
      }
    }
    const threshold = f.class === 'security' ? policy.blockSecurityAt : policy.blockQualityDebtAt;
    const blocking = status === 'new' && threshold !== undefined && rank(f.severity) >= rank(threshold);
    return { fingerprint: f.fingerprint, class: f.class, severity: f.severity, status, blocking, reasons };
  });
  const blocking = verdicts.filter((v) => v.blocking).map((v) => v.fingerprint);
  return {
    blocked: blocking.length > 0, blocking, verdicts,
    visibleDebt: {
      security: verdicts.filter((v) => v.status === 'existing' && v.class === 'security').length,
      qualityDebt: verdicts.filter((v) => v.status === 'existing' && v.class === 'quality-debt').length,
    },
  };
}

export interface Snapshot { sha: string; at: string; findings: readonly NormalizedFinding[] }
export interface TrendPoint {
  sha: string; at: string; total: number; security: number; qualityDebt: number;
  bySeverity: Record<Severity, number>; introduced: number; resolved: number;
}

/** Per-snapshot counts plus what each snapshot introduced and resolved relative to the previous one. */
export function trend(snapshots: readonly Snapshot[]): TrendPoint[] {
  const ordered = [...snapshots].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let prev = new Set<string>();
  return ordered.map((snap) => {
    const now = new Set(snap.findings.map((f) => f.fingerprint));
    const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const f of snap.findings) bySeverity[f.severity]++;
    const point: TrendPoint = {
      sha: snap.sha, at: snap.at, total: snap.findings.length, security: snap.findings.filter((f) => f.class === 'security').length,
      qualityDebt: snap.findings.filter((f) => f.class === 'quality-debt').length, bySeverity,
      introduced: [...now].filter((fp) => !prev.has(fp)).length, resolved: [...prev].filter((fp) => !now.has(fp)).length,
    };
    prev = now;
    return point;
  });
}

/** Turn the current findings into a baseline (acknowledged debt). Called by a reviewed action, never automatically. */
export function baselineFrom(findings: readonly NormalizedFinding[], now: Date, acknowledgedBy: string): BaselineEntry[] {
  return findings.map((f) => baselineEntrySchema.parse({ fingerprint: f.fingerprint, class: f.class, severity: f.severity, addedAt: now.toISOString(), acknowledgedBy }));
}
