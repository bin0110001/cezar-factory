import { describe, expect, it } from 'vitest';
import { checkProviderConfigSchema } from '../check-provider.js';
import { runCheck } from '../check-runner.js';
import { baselineFrom, evaluateFindingGate } from '../finding-policy.js';
import {
  activeQuarantine, analyzeTestChanges, changedLineCoverage, failureFindings, isTestPath, parseWeakeningGuard, testEffectivenessPlugin, unexecutedImpacted,
  type QuarantineEntry, type TestEffectivenessOptions,
} from './test-effectiveness-adapter.js';

const NOW = new Date('2026-11-16T12:00:00Z');
const DIGEST = `sha256:${'a'.repeat(64)}`;
const FUTURE = '2026-12-16T00:00:00Z';
const PAST = '2026-11-01T00:00:00Z';
const q = (over: Partial<QuarantineEntry> = {}): QuarantineEntry => ({ testId: 'flaky.spec > renders', environment: 'env-1', reason: 'timing on slow CI', reviewedBy: 'alice', reviewerKind: 'human', expiresAt: FUTURE, ...over });

describe('the existing weakening guard', () => {
  const failed = { exitCode: 1, stdout: '', stderr: 'WEAKENING GUARD FAILED:\n  - policies/verification.json/threshold: threshold lowered from 80 to 60\n  - config/x.json: suppression added ({"id":"a"})\n' };
  it('turns its violations into findings; a clean or not-enabled run has none; an error fails closed', () => {
    const f = parseWeakeningGuard(failed);
    expect(f).toHaveLength(2);
    expect(f.every((x) => x.severity === 'high' && x.id.startsWith('tests.guard:'))).toBe(true);
    expect(f[0]!.title).toContain('weakening guard:');
    expect(parseWeakeningGuard({ exitCode: 0, stdout: 'weakening guard passed (3 changed file(s) checked)', stderr: '' })).toEqual([]);
    expect(() => parseWeakeningGuard({ exitCode: 2, stdout: '', stderr: 'ERROR (fail closed): git diff failed' })).toThrow(/failed to run/);
  });
  it('identical violations get identical ids, so baselines match them', () => {
    expect(parseWeakeningGuard(failed).map((x) => x.id)).toEqual(parseWeakeningGuard(failed).map((x) => x.id));
  });
});

describe('source-level test weakening', () => {
  const before = "describe('x', () => {\n  it('a', () => { expect(1).toBe(1); expect(2).toBe(2) })\n  it('b', () => { expect(3).toBe(3) })\n})\n";
  const ch = (after: string | undefined, path = 'src/x.test.ts') => analyzeTestChanges([{ path, before, after }]).map((f) => f.id);

  it('weakening a test produces a finding: deletion, removed cases, new skips, dropped assertions', () => {
    expect(ch(undefined)).toEqual(['tests.deleted-test-file']);
    expect(ch("describe('x', () => {\n  it('a', () => { expect(1).toBe(1); expect(2).toBe(2) })\n})\n")).toEqual(['tests.removed-tests']);
    expect(ch("describe('x', () => {\n  it.skip('a', () => { expect(1).toBe(1); expect(2).toBe(2) })\n  it('b', () => { expect(3).toBe(3) })\n})\n")).toEqual(['tests.added-skip']);
    expect(ch("describe('x', () => {\n  it('a', () => { expect(1).toBe(1) })\n  it('b', () => { })\n})\n")).toEqual(['tests.weakened-assertions']);
  });

  it('ignores unchanged and strengthened tests, non-test files and brand-new test files', () => {
    expect(ch(before)).toEqual([]);
    expect(ch(before + "  it('c', () => { expect(4).toBe(4) })\n")).toEqual([]);
    expect(ch(undefined, 'src/app.ts')).toEqual([]);
    expect(analyzeTestChanges([{ path: 'src/new.test.ts', after: 'it("a", () => {})' }])).toEqual([]);
  });

  it('understands the other ecosystems', () => {
    expect(isTestPath('tests/test_x.py')).toBe(true);
    expect(isTestPath('src/App.Tests.cs')).toBe(true);
    expect(analyzeTestChanges([{ path: 'tests/test_x.py', before: 'def test_a():\n    assert 1\ndef test_b():\n    assert 2\n', after: 'def test_a():\n    assert 1\n' }]).map((f) => f.id)).toEqual(['tests.removed-tests']);
    expect(analyzeTestChanges([{ path: 'tests/test_x.py', before: 'def test_a():\n    assert 1\n', after: '@pytest.mark.skip\ndef test_a():\n    assert 1\n' }]).map((f) => f.id)).toEqual(['tests.added-skip']);
  });
});

describe('impacted suites and changed-line coverage', () => {
  it('an impacted suite that did not execute is reported, skipped and not-run both count as unexecuted', () => {
    expect(unexecutedImpacted(['unit', 'integration', 'e2e'], [{ suiteId: 'unit', status: 'passed' }, { suiteId: 'integration', status: 'skipped' }])).toEqual(['e2e', 'integration']);
    expect(unexecutedImpacted(['unit'], [{ suiteId: 'unit', status: 'failed' }])).toEqual([]);
    expect(unexecutedImpacted([], [])).toEqual([]);
  });
  it('changed-line coverage is optional and flags low coverage on changed source only', () => {
    expect(changedLineCoverage({ 'src/a.ts': [1, 2, 3, 4] }, undefined, 80)).toEqual([]);
    const f = changedLineCoverage({ 'src/a.ts': [1, 2, 3, 4], 'src/ok.ts': [1], 'src/x.test.ts': [1] }, { 'src/a.ts': [1], 'src/ok.ts': [1], 'src/x.test.ts': [] }, 80);
    expect(f.map((x) => x.id)).toEqual(['tests.low-changed-line-coverage:src/a.ts']);
    expect(f[0]!.title).toContain('25%');
  });
});

describe('flaky quarantine is scoped, reviewed and expiring', () => {
  const failing = { testId: 'flaky.spec > renders', suite: 'unit' };
  it('applies only in its environment, while unexpired, when reviewed by a human or operator', () => {
    expect(activeQuarantine([q()], failing, 'env-1', NOW).quarantined).toBe(true);
    expect(activeQuarantine([q()], failing, 'env-2', NOW)).toMatchObject({ quarantined: false, notes: [expect.stringContaining('different environment')] });
    expect(activeQuarantine([q({ expiresAt: PAST })], failing, 'env-1', NOW).notes[0]).toContain('expired');
    expect(activeQuarantine([q({ reviewedBy: undefined, reviewerKind: undefined })], failing, 'env-1', NOW).notes[0]).toContain('unreviewed');
    expect(activeQuarantine([q({ reviewerKind: 'agent' })], failing, 'env-1', NOW).notes[0]).toContain('agent-reviewed');
    expect(activeQuarantine([q({ suite: 'e2e' })], failing, 'env-1', NOW).quarantined).toBe(false);
    expect(activeQuarantine([q({ testId: 'other' })], failing, 'env-1', NOW).quarantined).toBe(false);
  });
  it('a quarantined failure is informational, an expired one blocks again', () => {
    expect(failureFindings([failing], [q()], 'env-1', NOW)[0]).toMatchObject({ id: 'tests.quarantined-flaky:flaky.spec > renders', severity: 'info' });
    expect(failureFindings([failing], [q({ expiresAt: PAST })], 'env-1', NOW)[0]).toMatchObject({ id: 'tests.failing:flaky.spec > renders', severity: 'high' });
  });
});

describe('through the check pipeline and baselines', () => {
  const def = checkProviderConfigSchema.parse({ version: 1, checks: [{ id: 'test-effectiveness', category: 'test', provider: { name: 'test-effectiveness', version: '1', digest: DIGEST }, scopes: ['changed-files'], triggers: ['pr-dev'], policy: { mandatory: true, timeoutMs: 1000 } }] }).checks[0]!;
  const run = (o: Partial<TestEffectivenessOptions>) => runCheck({ definition: def, plugin: testEffectivenessPlugin({ now: () => NOW, environment: 'env-1', ...o }), sourceSha: 'c'.repeat(40), scope: 's', artifactDigest: 'x', workerProfile: 'w', now: () => NOW });
  const removedTest = async () => [{ path: 'src/x.test.ts', before: "it('a', () => {})\nit('b', () => {})\n", after: "it('a', () => {})\n" }];

  it('weakening a test blocks the mandatory check; a clean change passes', async () => {
    const bad = await run({ testChanges: removedTest });
    expect(bad.result).toMatchObject({ status: 'fail', blockingFindingCount: 1 });
    expect((await run({ testChanges: async () => [] })).result.status).toBe('pass');
  });

  it('an impacted suite that did not run is UNKNOWN with a reason, never a pass, and a real failure stays a failure', async () => {
    const unknown = await run({ impacted: async () => ({ impacted: ['unit', 'e2e'], runs: [{ suiteId: 'unit', status: 'passed' }] }) });
    expect(unknown.result).toMatchObject({ status: 'unknown', execution: 'completed' });
    expect(unknown.result.reason).toContain('e2e');
    const both = await run({ testChanges: removedTest, impacted: async () => ({ impacted: ['e2e'], runs: [] }) });
    expect(both.result.status).toBe('fail');
    expect((await run({ impacted: async () => ({ impacted: ['unit'], runs: [{ suiteId: 'unit', status: 'passed' }] }) })).result.status).toBe('pass');
  });

  it('results link to the baselines: an accepted existing weakening stays visible without blocking, a new one blocks', async () => {
    const old = await run({ testChanges: removedTest });
    const baseline = baselineFrom(old.findings, new Date('2026-11-01T00:00:00Z'), 'alice');
    const now = await run({ testChanges: async () => [...(await removedTest()), { path: 'src/y.test.ts', before: "it('a', () => {})\n", after: undefined }] });
    const gate = evaluateFindingGate({ findings: now.findings, baseline, now: NOW, policy: { blockSecurityAt: 'high', blockQualityDebtAt: 'high' } });
    expect(gate.blocking).toHaveLength(1);
    expect(gate.verdicts.filter((v) => v.status === 'existing')).toHaveLength(1);
  });

  it('a quarantined flaky failure does not fail the check, but surfaces', async () => {
    const r = await run({ failing: async () => [{ testId: 'flaky.spec > renders' }], quarantine: [q()] });
    expect(r.result.status).toBe('warn');
    expect(r.findings[0]!.ruleId).toBe('tests.quarantined-flaky:flaky.spec > renders');
    expect((await run({ failing: async () => [{ testId: 'flaky.spec > renders' }], quarantine: [q({ expiresAt: PAST })] })).result.status).toBe('fail');
  });
});
