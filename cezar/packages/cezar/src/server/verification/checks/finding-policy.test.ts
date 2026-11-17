import { describe, expect, it } from 'vitest';
import type { CheckCategory } from './check-provider.js';
import {
  baselineFrom, diffAgainstBaseline, evaluateFindingGate, pathExclusionSchema, reviewProblems, suppressionSchema, trend,
  type PathExclusion, type Suppression,
} from './finding-policy.js';
import { classOfCategory, normalizeGenericJson, type NormalizedFinding } from './normalized-findings.js';

const NOW = new Date('2026-11-16T12:00:00Z');
const FUTURE = '2026-12-16T12:00:00Z';
const PAST = '2026-11-01T12:00:00Z';
const provider = { name: 'p', version: '1', digest: `sha256:${'a'.repeat(64)}` };

function make(category: CheckCategory, items: Array<Record<string, unknown>>): NormalizedFinding[] {
  return normalizeGenericJson({ findings: items }, { provider, category, sourceSha: 'c'.repeat(40), env: {} });
}
const vuln = (id: string, severity: string, pkg = 'lodash') => ({ id, severity, package: pkg, ecosystem: 'npm', title: `${id} CWE-79`, path: 'package-lock.json' });
const lint = (id: string, severity: string, path = 'src/a.ts') => ({ id, severity, title: 'style', path, line: 3 });

const reviewed = (over: Record<string, unknown> = {}) => ({ reason: 'tracked in #123', reviewedBy: 'alice', reviewerKind: 'human', reviewedAt: '2026-11-10T00:00:00Z', expiresAt: FUTURE, ...over });

describe('severity separation', () => {
  it('classifies by category, not by tool-reported severity', () => {
    expect(['sast', 'sca', 'secrets', 'iac', 'container', 'license'].every((c) => classOfCategory(c) === 'security')).toBe(true);
    expect(['format', 'lint', 'type', 'complexity', 'custom'].every((c) => classOfCategory(c) === 'quality-debt')).toBe(true);
    expect(make('lint', [lint('no-eval', 'critical')])[0]).toMatchObject({ class: 'quality-debt', severity: 'critical' });
    expect(make('sca', [vuln('CVE-2021-0001', 'low')])[0]?.class).toBe('security');
  });
});

describe('baseline diff and trend', () => {
  it('splits new, existing and fixed by the provider-independent fingerprint', () => {
    const [a, b] = make('sca', [vuln('CVE-2021-0001', 'high'), vuln('CVE-2021-0002', 'medium', 'minimist')]);
    const base = baselineFrom([a!], new Date('2026-10-01T00:00:00Z'), 'alice');
    const d = diffAgainstBaseline([b!], base, { now: NOW });
    expect(d.added.map((f) => f.fingerprint)).toEqual([b!.fingerprint]);
    expect(d.fixed.map((f) => f.fingerprint)).toEqual([a!.fingerprint]);
    expect(diffAgainstBaseline([a!, b!], base, { now: NOW }).existing).toHaveLength(1);
  });

  it('a stale baseline entry stops protecting its finding', () => {
    const [a] = make('sca', [vuln('CVE-2021-0001', 'high')]);
    const old = baselineFrom([a!], new Date('2026-01-01T00:00:00Z'), 'alice');
    expect(diffAgainstBaseline([a!], old, { now: NOW, maxAgeDays: 90 }).added).toHaveLength(1);
    expect(diffAgainstBaseline([a!], old, { now: NOW }).existing).toHaveLength(1);
  });

  it('reports counts by class and severity and what each snapshot introduced and resolved', () => {
    const f1 = make('sca', [vuln('CVE-2021-0001', 'high')]);
    const f2 = [...f1, ...make('lint', [lint('semi', 'low')])];
    const f3 = make('lint', [lint('semi', 'low')]);
    const t = trend([
      { sha: 'b'.repeat(40), at: '2026-11-02T00:00:00Z', findings: f2 },
      { sha: 'a'.repeat(40), at: '2026-11-01T00:00:00Z', findings: f1 },
      { sha: 'c'.repeat(40), at: '2026-11-03T00:00:00Z', findings: f3 },
    ]);
    expect(t.map((p) => [p.total, p.security, p.qualityDebt, p.introduced, p.resolved])).toEqual([[1, 1, 0, 1, 0], [2, 1, 1, 1, 0], [1, 0, 1, 0, 1]]);
    expect(t[0]?.bySeverity.high).toBe(1);
  });
});

describe('gate: new blocks, existing debt stays visible', () => {
  it('a new high-severity source finding blocks while acknowledged style debt remains visible without blocking', () => {
    const debt = make('lint', [lint('semi', 'high'), lint('quotes', 'medium')]);
    const sast = make('sast', [{ id: 'js.insecure-eval', severity: 'high', title: 'eval CWE-95', path: 'src/app.ts', line: 7 }]);
    const baseline = baselineFrom(debt, new Date('2026-10-20T00:00:00Z'), 'alice');
    const res = evaluateFindingGate({ findings: [...debt, ...sast], baseline, now: NOW });
    expect(res.blocked).toBe(true);
    expect(res.blocking).toEqual([sast[0]!.fingerprint]);
    expect(res.visibleDebt).toEqual({ security: 0, qualityDebt: 2 });
    expect(res.verdicts.filter((v) => v.status === 'existing').every((v) => !v.blocking)).toBe(true);
  });

  it('new quality debt does not block unless the policy says so; existing security debt never blocks', () => {
    const newLint = make('lint', [lint('semi', 'high')]);
    expect(evaluateFindingGate({ findings: newLint, baseline: [], now: NOW }).blocked).toBe(false);
    expect(evaluateFindingGate({ findings: newLint, baseline: [], now: NOW, policy: { blockSecurityAt: 'high', blockQualityDebtAt: 'high' } }).blocked).toBe(true);
    const cve = make('sca', [vuln('CVE-2021-0001', 'critical')]);
    expect(evaluateFindingGate({ findings: cve, baseline: baselineFrom(cve, NOW, 'a'), now: NOW }).blocked).toBe(false);
    expect(evaluateFindingGate({ findings: make('sca', [vuln('CVE-2021-0003', 'medium')]), baseline: [], now: NOW }).blocked).toBe(false); // below the default threshold
  });
});

describe('reviewed suppressions with expiry and path exclusions', () => {
  const finding = () => make('sast', [{ id: 'js.insecure-eval', severity: 'critical', title: 'x', path: 'src/legacy/old.ts', line: 1 }]);
  const sup = (over: Record<string, unknown> = {}): Suppression => suppressionSchema.parse({ ruleId: 'js.insecure-eval', pathGlob: 'src/legacy/**', ...reviewed(), ...over });
  const run = (s: Suppression[], ex: PathExclusion[] = []) => evaluateFindingGate({ findings: finding(), baseline: [], suppressions: s, exclusions: ex, now: NOW });

  it('a reviewed, unexpired suppression stops the block', () => {
    const r = run([sup()]);
    expect(r.blocked).toBe(false);
    expect(r.verdicts[0]).toMatchObject({ status: 'suppressed' });
  });

  it('an expired suppression blocks again', () => {
    const r = run([sup({ expiresAt: PAST })]);
    expect(r.blocked).toBe(true);
    expect(r.verdicts[0]?.reasons.join(' ')).toMatch(/expired/);
  });

  it('an unreviewed or agent-reviewed suppression is ignored', () => {
    for (const over of [{ reviewedBy: undefined, reviewerKind: undefined, reviewedAt: undefined }, { reviewerKind: 'agent' }]) {
      const r = run([sup(over)]);
      expect(r.blocked).toBe(true);
      expect(r.verdicts[0]?.reasons.join(' ')).toMatch(/unreviewed|agent-reviewed/);
    }
  });

  it('scope matters: another rule or path is not suppressed, and blanket suppressions are rejected', () => {
    expect(run([sup({ ruleId: 'other-rule' })]).blocked).toBe(true);
    expect(run([sup({ pathGlob: 'src/other/**' })]).blocked).toBe(true);
    expect(suppressionSchema.safeParse({ ...reviewed() }).success).toBe(false);
    expect(suppressionSchema.safeParse({ ruleId: 'r', reason: 'x', expiresAt: 'tomorrow' }).success).toBe(false);
  });

  it('path exclusions follow the same review and expiry rules', () => {
    const ex = (over: Record<string, unknown> = {}) => pathExclusionSchema.parse({ glob: 'src/legacy/**', ...reviewed(), ...over });
    expect(run([], [ex()]).verdicts[0]).toMatchObject({ status: 'excluded' });
    expect(run([], [ex({ expiresAt: PAST })]).blocked).toBe(true);
    expect(run([], [ex({ reviewedBy: undefined, reviewerKind: undefined })]).blocked).toBe(true);
    expect(run([], [ex({ glob: 'vendor/**' })]).blocked).toBe(true);
  });

  it('reviewProblems names each reason', () => {
    expect(reviewProblems({ expiresAt: PAST }, NOW)).toEqual(['unreviewed', 'expired']);
    expect(reviewProblems({ reviewedBy: 'bot', reviewerKind: 'agent', expiresAt: FUTURE }, NOW)).toEqual(['agent-reviewed']);
    expect(reviewProblems({ reviewedBy: 'a', reviewerKind: 'operator', expiresAt: FUTURE }, NOW)).toEqual([]);
  });
});
