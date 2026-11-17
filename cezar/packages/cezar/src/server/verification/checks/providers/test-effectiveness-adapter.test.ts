import { describe, expect, it } from 'vitest';
import { checkProviderConfigSchema } from '../check-provider.js';
import { runCheck } from '../check-runner.js';
import { evaluateQuarantine, testEffectivenessPlugin, type TestEffectivenessInputs } from './test-effectiveness-adapter.js';

const DIGEST = `sha256:${'b'.repeat(64)}`;
const NOW = new Date('2026-11-17T12:00:00Z');
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const def = checkProviderConfigSchema.parse({ version: 1, checks: [{
  id: 'test-effectiveness', category: 'test', provider: { name: 'test-effectiveness', version: '1.0.0', digest: DIGEST },
  scopes: ['changed-files'], triggers: ['pr-dev'], policy: { mandatory: true, timeoutMs: 1000 },
}] }).checks[0]!;

const base: TestEffectivenessInputs = {
  weakening: { exitCode: 0, stderr: '' }, selectedSuites: ['unit'], executedSuites: ['unit'], failures: [], quarantine: [],
  baselines: { linux: 'bl-1' },
};
const q = (over: Record<string, unknown> = {}) => ({ testId: 't1', environmentKey: 'linux', expiresAt: '2026-11-20T00:00:00Z', createdAt: '2026-11-17T00:00:00Z', reviewer: 'alice', ...over });

function run(over: Partial<TestEffectivenessInputs> | (() => Promise<TestEffectivenessInputs>), extra = {}) {
  const collect = typeof over === 'function' ? over : async () => ({ ...base, ...over });
  return runCheck({ definition: def, plugin: testEffectivenessPlugin({ collect, now: () => NOW, ...extra }), sourceSha: 'c'.repeat(40), scope: 's', artifactDigest: 'x', workerProfile: 'w', now: () => NOW, secrets: [SECRET] });
}

describe('test-effectiveness provider', () => {
  it('clean run passes', async () => { expect((await run({})).result.status).toBe('pass'); });
  it('weakening produces a blocking finding with a stable fingerprint', async () => {
    const o1 = await run({ weakening: { exitCode: 1, stderr: 'guard\n  - deleted test tests/a.test.ts\n' } });
    const o2 = await run({ weakening: { exitCode: 1, stderr: '  - deleted test tests/a.test.ts' } });
    expect(o1.result.status).toBe('fail');
    expect(o1.findings[0]!.ruleId).toBe('test-weakening.deletion');
    expect(o1.findings[0]!.fingerprint).toBe(o2.findings[0]!.fingerprint);
  });
  it('guard exit 2, crash or unrecognized output is error, never pass', async () => {
    expect((await run({ weakening: { exitCode: 2, stderr: '' } })).result.status).toBe('error');
    expect((await run({ weakening: { exitCode: 1, stderr: 'garbage' } })).result.status).toBe('error');
    expect((await run(async () => { throw new Error('boom'); })).result.status).toBe('error');
  });
  it('unexecuted impacted suite is unknown with not-run, never pass', async () => {
    const o = await run({ selectedSuites: ['unit', 'integration'] });
    expect(o.result.status).toBe('unknown');
    expect(o.result.reason).toMatch(/not-run.*integration/);
  });
  it('unexecuted suite alongside weakening still fails', async () => {
    const o = await run({ selectedSuites: ['unit', 'integration'], weakening: { exitCode: 1, stderr: '  - skipped test' } });
    expect(o.result.status).toBe('fail');
    expect(o.findings.map((f) => f.ruleId)).toContain('impacted-suite-not-run');
  });
  it('invalid or expired quarantine is a normal failure', async () => {
    const f = [{ testId: 't1', environmentKey: 'linux' }];
    for (const bad of [q({ reviewer: undefined }), q({ expiresAt: undefined }), q({ expiresAt: '2026-11-01T00:00:00Z' }), q({ environmentKey: 'win' }), q({ expiresAt: '2027-03-01T00:00:00Z' })]) {
      const o = await run({ failures: f, quarantine: [bad] });
      expect(o.result.status).toBe('fail');
    }
  });
  it('valid quarantine downgrades to warn and links the #54 baseline', async () => {
    const o = await run({ failures: [{ testId: 't1', environmentKey: 'linux' }], quarantine: [q()] });
    expect(o.result.status).toBe('warn');
    expect(o.findings[0]!.references).toContain('baseline:linux:bl-1');
  });
  it('quarantine evaluation fails closed on scope and expiry', () => {
    const f = { testId: 't1', environmentKey: 'linux' };
    expect(evaluateQuarantine(q(), f, NOW)).toEqual({ active: true });
    expect(evaluateQuarantine(q(), f, new Date('2026-12-01T00:00:00Z'))).toMatchObject({ active: false });
  });
  it('changed-line coverage is optional; required-but-missing is unknown', async () => {
    expect((await run({})).result.status).toBe('pass');
    expect((await run({}, { requireCoverage: true })).result.status).toBe('unknown');
    const o = await run({ coverage: { coveredChangedLines: 1, totalChangedLines: 10 } }, { minChangedLineCoverage: 80 });
    expect(o.result.status).toBe('warn');
  });
  it('redacts secrets in findings', async () => {
    const o = await run({ weakening: { exitCode: 1, stderr: `  - deleted test using ${SECRET}` } });
    expect(JSON.stringify(o.findings)).not.toContain(SECRET);
  });
});
