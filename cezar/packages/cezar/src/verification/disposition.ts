import { createHash } from 'node:crypto';

/**
 * Verification dispositions (#664). A disposition is the per-run decision about a finding, kept apart from the immutable
 * observation (an occurrence) and from the persistent Finding/Episode in the ledger. The rules are pure and deterministic, so a
 * replay of the same inputs yields identical dispositions, and they never produce a pass from missing or unusable evidence.
 *
 * `known` is not `waived`: known means "the same as a trusted baseline"; a waiver is a separate, scoped, expiring decision by an
 * independent authority, carried as a flag and never changing the decision.
 */

export const DISPOSITIONS = ['new', 'known', 'worsened', 'resolved', 'reopened', 'untested', 'unknown', 'infra-failure'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

const SEV = ['info', 'low', 'medium', 'high', 'critical'] as const;
type Severity = (typeof SEV)[number];
const rank = (s: string): number => Math.max(0, SEV.indexOf(s as Severity));

/** A baseline counts only from integration or approved evidence. A feature-branch rerun can never make a new failure known. */
export const TRUSTED_BASELINE_SOURCES = ['integration', 'approved-evidence'] as const;

export interface BaselineEntry { fingerprint: string; severity: string }
export interface TrustedBaseline {
  source: string;
  sha: string;
  envFingerprint: string;
  at: string;
  entries: readonly BaselineEntry[];
}

export interface FindingInput { fingerprint: string; severity: string }

export interface RunFacts {
  /** The check outcome: `pass|fail|warn|unknown|error|not-applicable`. */
  status: string;
  execution: 'completed' | 'failed' | 'timeout' | 'not-run';
  /** The selected tests/rules were all executed (no skipped or missing suite). */
  selectionComplete: boolean;
  /** Coverage of the changed scope is complete enough to say something is resolved. */
  coverageComplete: boolean;
  evidenceFresh: boolean;
  envFingerprint: string;
  baseSha: string;
  policyVersion: string;
  actor: string;
}

export interface DispositionInput {
  findings: readonly FindingInput[];
  baseline: TrustedBaseline | undefined;
  /** Fingerprints with an open episode in the ledger for this check, and ones whose last episode was resolved. */
  previouslyOpen: readonly string[];
  previouslyResolved: readonly string[];
  /** Fingerprints under a valid waiver (independent authority). Reported as a flag; never changes the decision. */
  waived?: readonly string[];
  run: RunFacts;
}

export interface DispositionRecord {
  fingerprint: string;
  decision: Disposition;
  severity: string;
  reason: string;
  waived: boolean;
  baselineSha: string | null;
  baseSha: string;
  envFingerprint: string;
  policyVersion: string;
  actor: string;
}

export type RunDisposition = 'compared' | 'untrusted-baseline' | 'environment-changed' | 'unknown' | 'untested' | 'infra-failure';

export interface DispositionResult {
  run: RunDisposition;
  records: DispositionRecord[];
  /** Episodes that may be resolved in the ledger: only a complete, comparable run resolves anything. */
  resolvable: string[];
  /** Digest over the canonical records: equal for equal inputs, so a replay is detectable. */
  digest: string;
  summary: Record<Disposition, number>;
}

export function baselineTrust(b: TrustedBaseline | undefined): { trusted: boolean; reason: string } {
  if (!b) return { trusted: false, reason: 'no baseline' };
  if (!(TRUSTED_BASELINE_SOURCES as readonly string[]).includes(b.source)) return { trusted: false, reason: `baseline source ${b.source} is not trusted (integration or approved evidence only)` };
  if (!b.sha) return { trusted: false, reason: 'baseline has no SHA' };
  return { trusted: true, reason: 'trusted baseline' };
}

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

export function computeDispositions(input: DispositionInput): DispositionResult {
  const { run } = input;
  const waived = new Set(input.waived ?? []);
  const rec = (fingerprint: string, decision: Disposition, severity: string, reason: string): DispositionRecord => ({
    fingerprint, decision, severity, reason, waived: waived.has(fingerprint), baselineSha: input.baseline?.sha ?? null, baseSha: run.baseSha,
    envFingerprint: run.envFingerprint, policyVersion: run.policyVersion, actor: run.actor,
  });
  const finish = (runDisposition: RunDisposition, records: DispositionRecord[], resolvable: string[]): DispositionResult => {
    const sorted = [...records].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint) || a.decision.localeCompare(b.decision));
    const summary = Object.fromEntries(DISPOSITIONS.map((d) => [d, sorted.filter((r) => r.decision === d).length])) as Record<Disposition, number>;
    return { run: runDisposition, records: sorted, resolvable: [...resolvable].sort(), digest: `sha256:${sha({ runDisposition, sorted, resolvable: [...resolvable].sort() })}`, summary };
  };
  const present = [...new Map(input.findings.map((f) => [f.fingerprint, f])).values()];
  const all = (decision: Disposition, reason: string) => present.map((f) => rec(f.fingerprint, decision, f.severity, reason));

  // A run that did not complete says nothing about what is fixed: nothing resolves, and open findings are retained.
  if (run.execution !== 'completed' || run.status === 'error') {
    return finish('infra-failure', [...all('infra-failure', 'the check did not complete'), ...input.previouslyOpen.filter((fp) => !present.some((f) => f.fingerprint === fp)).map((fp) => rec(fp, 'infra-failure', 'info', 'open finding retained: the run did not complete'))], []);
  }
  if (run.status === 'not-applicable' || !run.selectionComplete) {
    return finish('untested', [...all('untested', run.status === 'not-applicable' ? 'the check is not applicable here' : 'the selected tests or rules were not all executed'), ...input.previouslyOpen.filter((fp) => !present.some((f) => f.fingerprint === fp)).map((fp) => rec(fp, 'untested', 'info', 'open finding retained: selection incomplete'))], []);
  }
  if (run.status === 'unknown' || !run.evidenceFresh) {
    return finish('unknown', [...all('unknown', run.evidenceFresh ? 'the check result is unknown' : 'the evidence is stale'), ...input.previouslyOpen.filter((fp) => !present.some((f) => f.fingerprint === fp)).map((fp) => rec(fp, 'unknown', 'info', 'open finding retained: evidence unusable'))], []);
  }

  const trust = baselineTrust(input.baseline);
  const reopened = new Set(input.previouslyResolved);
  const open = new Set(input.previouslyOpen);
  const currentSet = new Set(present.map((f) => f.fingerprint));

  if (!trust.trusted) {
    // Without a trusted baseline nothing can be "known": every present finding is new (reopened if it had been resolved).
    const records = present.map((f) => (reopened.has(f.fingerprint) && !open.has(f.fingerprint) ? rec(f.fingerprint, 'reopened', f.severity, `previously resolved; ${trust.reason}`) : rec(f.fingerprint, 'new', f.severity, trust.reason)));
    return finish('untrusted-baseline', records, run.coverageComplete ? [...open].filter((fp) => !currentSet.has(fp)) : []);
  }
  const baseline = input.baseline!;
  if (baseline.envFingerprint !== run.envFingerprint) {
    return finish('environment-changed', all('unknown', 'the environment differs from the baseline, so the comparison is not valid'), []);
  }

  const base = new Map(baseline.entries.map((e) => [e.fingerprint, e]));
  const records: DispositionRecord[] = [];
  for (const f of present) {
    const b = base.get(f.fingerprint);
    if (reopened.has(f.fingerprint) && !open.has(f.fingerprint)) records.push(rec(f.fingerprint, 'reopened', f.severity, 'resolved before, present again'));
    else if (!b) records.push(rec(f.fingerprint, 'new', f.severity, 'not in the trusted baseline'));
    else if (rank(f.severity) > rank(b.severity)) records.push(rec(f.fingerprint, 'worsened', f.severity, `severity rose from ${b.severity} to ${f.severity}`));
    else records.push(rec(f.fingerprint, 'known', f.severity, 'same as the trusted baseline'));
  }
  const resolvable: string[] = [];
  if (run.coverageComplete) {
    // Gone from the run and either open in the ledger or in the baseline: resolved (e.g. 42 known warnings, 39 now, 3 resolved).
    const gone = new Set([...open, ...base.keys()].filter((fp) => !currentSet.has(fp)));
    for (const fp of gone) {
      records.push(rec(fp, 'resolved', base.get(fp)?.severity ?? 'info', open.has(fp) ? 'no longer present, with complete coverage' : 'in the baseline, no longer present'));
      if (open.has(fp)) resolvable.push(fp);
    }
  }
  return finish('compared', records, resolvable);
}

/** Promote a run's open findings into a baseline entry set, for a reviewed `integration` or `approved-evidence` baseline. */
export function baselineFromFindings(findings: readonly FindingInput[], meta: { source: string; sha: string; envFingerprint: string; at: string }): TrustedBaseline {
  return { ...meta, entries: findings.map((f) => ({ fingerprint: f.fingerprint, severity: f.severity })) };
}
