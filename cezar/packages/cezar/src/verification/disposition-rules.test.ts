import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { baselineFromFindings, computeDispositions, type RunFacts } from './disposition.ts';
import {
  decideStage, dispositionPolicyJsonSchema, dispositionPolicySchema, policyEditViolations, type CheckRun, type DispositionPolicy, type FindingFacts,
} from './disposition-rules.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const shipped = (): DispositionPolicy => dispositionPolicySchema.parse(JSON.parse(read('../../../../../policies/verification.json')).dispositionRules);

const fp = (n: number) => n.toString(16).padStart(64, '0');
const run = (over: Partial<RunFacts> = {}): RunFacts => ({ status: 'warn', execution: 'completed', selectionComplete: true, coverageComplete: true, evidenceFresh: true, envFingerprint: 'e', baseSha: 'b'.repeat(40), policyVersion: 'p', actor: 'ci', ...over });
const base = (n: number) => baselineFromFindings(Array.from({ length: n }, (_, i) => ({ fingerprint: fp(i + 1), severity: 'low' })), { source: 'integration', sha: 'a'.repeat(40), envFingerprint: 'e', at: '2026-11-01T00:00:00Z' });

function check(checkId: string, found: Array<{ n: number; severity: string; facts?: Partial<FindingFacts> }>, opts: { baseline?: number; facts?: Partial<RunFacts>; attempts?: number; open?: number[] } = {}): CheckRun {
  const result = computeDispositions({
    findings: found.map((f) => ({ fingerprint: fp(f.n), severity: f.severity })), baseline: base(opts.baseline ?? 0),
    previouslyOpen: (opts.open ?? []).map(fp), previouslyResolved: [], run: run(opts.facts),
  });
  const facts = Object.fromEntries(found.map((f) => [fp(f.n), { class: 'security', severity: f.severity, impacted: false, ...f.facts } as FindingFacts]));
  return { checkId, result, facts, attempts: opts.attempts ?? 0 };
}

describe('shipped policy', () => {
  it('is valid, covers the stages and matches the committed JSON schema', () => {
    const p = shipped();
    expect(Object.keys(p.stages)).toEqual(['pr-dev', 'candidate', 'stable']);
    const committed = JSON.parse(read('../../../../../schemas/verification-disposition-policy.schema.json'));
    expect(committed).toEqual(JSON.parse(JSON.stringify(dispositionPolicyJsonSchema())));
  });

  it('is a protected asset: an implementation change to it, baselines or waivers is rejected', () => {
    const globs = (JSON.parse(read('../../../../../policies/protected-assets.json')).assets as Array<{ globs: string[] }>).flatMap((a) => a.globs);
    expect(policyEditViolations(['src/app.ts', 'docs/x.md'], globs)).toEqual([]);
    expect(policyEditViolations(['policies/verification.json', 'src/app.ts'], globs)).toEqual(['policies/verification.json']);
    expect(policyEditViolations(['web/baselines/visual.baseline.json', 'tests/x.baseline'], globs).length).toBe(2);
  });
});

describe('policy validation', () => {
  const policy = (stage: unknown) => ({ version: '1', stages: { s: stage } });
  it('rejects a duplicate rule id and any way of continuing past an unusable run', () => {
    const rule = { id: 'r', when: { decision: ['new'] }, action: 'RECORD', reason: 'x' };
    expect(dispositionPolicySchema.safeParse(policy({ rules: [rule, rule] })).success).toBe(false);
    expect(dispositionPolicySchema.safeParse(policy({ default: { unknown: 'CONTINUE' } })).success).toBe(false);
    expect(dispositionPolicySchema.safeParse(policy({ default: { 'infra-failure': 'CONTINUE' } })).success).toBe(false);
    expect(dispositionPolicySchema.safeParse(policy({ rules: [{ id: 'c', when: { decision: ['untested'] }, action: 'CONTINUE', reason: 'x' }] })).success).toBe(false);
    expect(dispositionPolicySchema.safeParse(policy({ rules: [{ id: 'c', when: { decision: ['known'] }, action: 'CONTINUE', reason: 'x' }] })).success).toBe(true);
    expect(dispositionPolicySchema.safeParse(policy({ unexpected: 1 })).success).toBe(false);
    expect(dispositionPolicySchema.safeParse({ version: '1', stages: { s: { rules: [{ id: 'r', when: { decision: ['bogus'] }, action: 'BLOCK', reason: 'x' }] } } }).success).toBe(false);
  });
});

describe('rules per stage', () => {
  const p = shipped();

  it('unchanged approved debt continues while a new focused regression blocks', () => {
    const debt = check('lint', [{ n: 1, severity: 'low', facts: { class: 'quality-debt' } }, { n: 2, severity: 'low', facts: { class: 'quality-debt' } }], { baseline: 2 });
    expect(decideStage(p, 'candidate', [debt]).action).toBe('CONTINUE');
    const regression = check('acceptance', [{ n: 9, severity: 'high', facts: { class: 'quality-debt', impacted: true } }], { baseline: 0 });
    const d = decideStage(p, 'candidate', [debt, regression]);
    expect(d.action).toBe('BLOCK');
    expect(d.decisions.find((x) => x.action === 'BLOCK')).toMatchObject({ ruleId: 'impacted-regression', checkId: 'acceptance' });
  });

  it('a new minor finding becomes a follow-up, not a block', () => {
    const minor = check('lint', [{ n: 5, severity: 'low', facts: { class: 'quality-debt' } }]);
    const d = decideStage(p, 'pr-dev', [minor, check('automation-catalog', [])]);
    expect(d.action).toBe('RECORD');
    expect(d.followUps).toEqual([fp(5)]);
    expect(d.blocked).toBe(false);
  });

  it('a new high or critical security finding blocks at candidate and stable but is only recorded on a PR', () => {
    const sec = check('dependency-scan', [{ n: 7, severity: 'critical', facts: { class: 'security', category: 'sca' } }]);
    expect(decideStage(p, 'stable', [sec, check('full-suite', [])]).action).toBe('BLOCK');
    expect(decideStage(p, 'candidate', [sec]).action).toBe('BLOCK');
    expect(decideStage(p, 'pr-dev', [sec, check('automation-catalog', [])]).action).toBe('RECORD');
  });

  it('missing coverage stays unknown: a required check that did not run blocks, an optional unusable one is recorded', () => {
    expect(decideStage(p, 'stable', []).decisions[0]).toMatchObject({ ruleId: 'stage-minimum', action: 'BLOCK', decision: 'untested' });
    const untested = check('e2e', [], { facts: { selectionComplete: false } });
    const d = decideStage(p, 'pr-dev', [untested, check('automation-catalog', [])]);
    expect(d.action).toBe('RECORD');
    expect(d.decisions.find((x) => x.checkId === 'e2e')).toMatchObject({ decision: 'untested', action: 'RECORD' });
    const requiredUnknown = check('full-suite', [], { facts: { evidenceFresh: false } });
    expect(decideStage(p, 'stable', [requiredUnknown]).action).toBe('BLOCK');
  });

  it('a scanner or runner outage retries, then escalates to BLOCK', () => {
    const outage = (attempts: number) => check('dependency-scan', [], { facts: { execution: 'failed' }, attempts });
    const first = decideStage(p, 'candidate', [outage(0)]);
    expect(first.action).toBe('RETRY');
    expect(first.retry).toEqual(['dependency-scan']);
    const last = decideStage(p, 'candidate', [outage(p.stages.candidate!.maxRetries)]);
    expect(last.action).toBe('BLOCK');
    expect(last.escalated).toEqual(['dependency-scan']);
  });

  it('every stage rule in the shipped policy fires for some input and the summary stays short', () => {
    const fired = new Set<string>();
    const cases: Array<[string, CheckRun[]]> = [
      ['pr-dev', [check('automation-catalog', []), check('x', [{ n: 1, severity: 'critical', facts: { class: 'security' } }])]],
      ['candidate', [check('acceptance', [{ n: 2, severity: 'high', facts: { impacted: true, class: 'quality-debt' } }]), check('dependency-scan', [{ n: 3, severity: 'high', facts: { class: 'security' } }])]],
      ['stable', [check('full-suite', []), check('dependency-scan', [{ n: 4, severity: 'critical', facts: { class: 'security' } }])]],
    ];
    for (const [stage, runs] of cases) {
      const d = decideStage(p, stage, runs);
      d.decisions.forEach((x) => x.ruleId && fired.add(`${stage}:${x.ruleId}`));
      expect(d.summary.split('\n')).toHaveLength(1);
      expect(d.summary.length).toBeLessThan(600);
    }
    expect(fired.has('candidate:impacted-regression')).toBe(true);
    expect([...fired].some((f) => f.startsWith('stable:') && f !== 'stable:stage-minimum')).toBe(true);
  });

  it('surfaces rows for the Operations and Verification views and rejects an unknown stage', () => {
    const d = decideStage(p, 'candidate', [check('lint', [{ n: 1, severity: 'low', facts: { class: 'quality-debt' } }], { baseline: 1 })]);
    expect(d.rows).toEqual([{ checkId: 'lint', run: 'compared', counts: expect.objectContaining({ known: 1 }), action: 'CONTINUE' }]);
    expect(() => decideStage(p, 'nightly', [])).toThrow(/no disposition policy/);
  });

  it('is deterministic: the same inputs decide identically', () => {
    const runs = [check('lint', [{ n: 1, severity: 'low', facts: { class: 'quality-debt' } }, { n: 2, severity: 'high', facts: { class: 'security' } }], { baseline: 1 })];
    expect(decideStage(p, 'candidate', runs)).toEqual(decideStage(p, 'candidate', structuredClone(runs)));
  });
});
