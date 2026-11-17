import { describe, expect, it } from 'vitest';
import { baselineFromFindings, baselineTrust, computeDispositions, type FindingInput, type RunFacts, type TrustedBaseline } from './disposition.ts';

const fp = (n: number) => n.toString(16).padStart(64, '0');
const findings = (n: number, severity = 'low'): FindingInput[] => Array.from({ length: n }, (_, i) => ({ fingerprint: fp(i + 1), severity }));
const baseline = (entries: FindingInput[], over: Partial<TrustedBaseline> = {}): TrustedBaseline =>
  ({ ...baselineFromFindings(entries, { source: 'integration', sha: 'a'.repeat(40), envFingerprint: 'env-1', at: '2026-11-01T00:00:00Z' }), ...over });
const run = (over: Partial<RunFacts> = {}): RunFacts => ({
  status: 'warn', execution: 'completed', selectionComplete: true, coverageComplete: true, evidenceFresh: true, envFingerprint: 'env-1', baseSha: 'b'.repeat(40),
  policyVersion: 'policy-7', actor: 'ci', ...over,
});
const decisions = (r: ReturnType<typeof computeDispositions>) => r.records.map((x) => x.decision);

describe('baseline comparison', () => {
  it('42 known warnings compare as 39 unchanged plus 3 resolved', () => {
    const base = baseline(findings(42));
    const open = findings(42).map((f) => f.fingerprint);
    const r = computeDispositions({ findings: findings(39), baseline: base, previouslyOpen: open, previouslyResolved: [], run: run() });
    expect(r.run).toBe('compared');
    expect(r.summary).toMatchObject({ known: 39, resolved: 3, new: 0, worsened: 0 });
    expect(r.resolvable).toEqual([fp(40), fp(41), fp(42)]);
  });

  it('classifies new, worsened and reopened relative to the trusted baseline', () => {
    const base = baseline([{ fingerprint: fp(1), severity: 'low' }, { fingerprint: fp(2), severity: 'medium' }]);
    const r = computeDispositions({
      findings: [{ fingerprint: fp(1), severity: 'high' }, { fingerprint: fp(2), severity: 'medium' }, { fingerprint: fp(3), severity: 'critical' }, { fingerprint: fp(4), severity: 'low' }],
      baseline: base, previouslyOpen: [fp(1), fp(2)], previouslyResolved: [fp(4)], run: run(),
    });
    const by = Object.fromEntries(r.records.map((x) => [x.fingerprint, x.decision]));
    expect(by).toEqual({ [fp(1)]: 'worsened', [fp(2)]: 'known', [fp(3)]: 'new', [fp(4)]: 'reopened' });
  });

  it('a baseline from a feature-branch rerun is untrusted, so a new failure can never become known', () => {
    for (const source of ['feature-branch', 'pr-rerun', 'agent', '']) {
      expect(baselineTrust(baseline(findings(2), { source })).trusted).toBe(false);
      const r = computeDispositions({ findings: findings(2), baseline: baseline(findings(2), { source }), previouslyOpen: [], previouslyResolved: [], run: run() });
      expect(r.run).toBe('untrusted-baseline');
      expect(decisions(r)).toEqual(['new', 'new']);
    }
    expect(baselineTrust(undefined)).toMatchObject({ trusted: false });
    expect(baselineTrust(baseline([], { source: 'approved-evidence' })).trusted).toBe(true);
  });

  it('known is not waived: a waiver is a separate flag and does not change the decision', () => {
    const r = computeDispositions({ findings: findings(2), baseline: baseline([{ fingerprint: fp(1), severity: 'low' }]), previouslyOpen: [], previouslyResolved: [], waived: [fp(2)], run: run() });
    const by = Object.fromEntries(r.records.map((x) => [x.fingerprint, [x.decision, x.waived]]));
    expect(by).toEqual({ [fp(1)]: ['known', false], [fp(2)]: ['new', true] });
  });
});

describe('unusable evidence never passes and never resolves', () => {
  const open = [fp(1), fp(2)];
  const call = (over: Partial<RunFacts>, found = findings(1)) => computeDispositions({ findings: found, baseline: baseline(findings(2)), previouslyOpen: open, previouslyResolved: [], run: run(over) });

  it('a changed environment makes the comparison unknown', () => {
    const r = call({ envFingerprint: 'env-2' });
    expect(r.run).toBe('environment-changed');
    expect(decisions(r)).toEqual(['unknown']);
    expect(r.resolvable).toEqual([]);
  });

  it('a different baseline environment is the same case seen from the other side', () => {
    const r = computeDispositions({ findings: findings(1), baseline: baseline(findings(2), { envFingerprint: 'env-0' }), previouslyOpen: open, previouslyResolved: [], run: run() });
    expect(r.run).toBe('environment-changed');
  });

  it('a missing suite or incomplete selection is untested and retains open findings', () => {
    const r = call({ selectionComplete: false }, []);
    expect(r.run).toBe('untested');
    expect(decisions(r)).toEqual(['untested', 'untested']);
    expect(r.resolvable).toEqual([]);
    expect(call({ status: 'not-applicable' }, []).run).toBe('untested');
  });

  it('stale evidence or an unknown result is unknown', () => {
    expect(call({ evidenceFresh: false }, []).run).toBe('unknown');
    expect(call({ status: 'unknown' }, []).run).toBe('unknown');
    expect(call({ evidenceFresh: false }, []).resolvable).toEqual([]);
  });

  it('a runner crash, timeout or error is an infrastructure failure, never a pass', () => {
    for (const over of [{ execution: 'failed' as const }, { execution: 'timeout' as const }, { execution: 'not-run' as const }, { status: 'error' }]) {
      const r = call(over, []);
      expect(r.run).toBe('infra-failure');
      expect(decisions(r)).toEqual(['infra-failure', 'infra-failure']);
      expect(r.resolvable).toEqual([]);
    }
  });

  it('incomplete coverage keeps a vanished finding open instead of resolving it', () => {
    const r = call({ coverageComplete: false }, []);
    expect(r.run).toBe('compared');
    expect(r.resolvable).toEqual([]);
    expect(r.summary.resolved).toBe(0);
  });
});

describe('replay', () => {
  it('identical inputs give identical dispositions and digest; any input change moves the digest', () => {
    const input = { findings: findings(5), baseline: baseline(findings(3)), previouslyOpen: [fp(1)], previouslyResolved: [fp(5)], run: run() };
    const a = computeDispositions(input);
    const b = computeDispositions(structuredClone(input));
    expect(b).toEqual(a);
    expect(a.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(computeDispositions({ ...input, run: run({ policyVersion: 'policy-8' }) }).digest).not.toBe(a.digest);
    expect(computeDispositions({ ...input, findings: [...input.findings].reverse() }).digest).toBe(a.digest); // order does not matter
  });

  it('every record carries the effective policy version, base SHA, environment and actor', () => {
    const r = computeDispositions({ findings: findings(1), baseline: baseline([]), previouslyOpen: [], previouslyResolved: [], run: run() });
    expect(r.records[0]).toMatchObject({ policyVersion: 'policy-7', baseSha: 'b'.repeat(40), envFingerprint: 'env-1', actor: 'ci', baselineSha: 'a'.repeat(40) });
  });
});
