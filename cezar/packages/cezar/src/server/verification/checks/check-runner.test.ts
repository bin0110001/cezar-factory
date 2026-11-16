import { describe, expect, it } from 'vitest';
import { checkProviderConfigSchema, type CheckDefinition } from './check-provider.js';
import { CheckResultCache, aggregateCategory, runCheck, type CheckProviderPlugin, type PluginRunOutput } from './check-runner.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const SHA = 'c'.repeat(40);
const NOW = new Date('2026-11-16T12:00:00Z');
const FRESH = '2026-11-16T00:00:00Z';

function def(name: string, over: Record<string, unknown> = {}, policy: Record<string, unknown> = {}): CheckDefinition {
  return checkProviderConfigSchema.parse({ version: 1, checks: [{
    id: `${name}-check`, category: 'sca', provider: { name, version: '1.0.0', digest: DIGEST }, scopes: ['full-repo'], triggers: ['pr-dev'],
    policy: { mandatory: true, timeoutMs: 1000, maxAgeHours: 48, cache: { enabled: true, ttlHours: 24 }, ...policy }, ...over,
  }] }).checks[0];
}

const sarif = (cve = 'CVE-2021-23337', severity = 'HIGH'): PluginRunOutput => ({
  format: 'sarif', dbUpdatedAt: FRESH,
  document: { runs: [{ results: [{ ruleId: cve, level: 'error', message: { text: 'lodash vulnerable' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'package-lock.json' } } }] }], tool: { driver: { rules: [{ id: cve, properties: { severity, packageName: 'lodash', ecosystem: 'npm' } }] } } }] },
});
const clean: PluginRunOutput = { format: 'json', dbUpdatedAt: FRESH, document: { findings: [] } };

function fake(output: PluginRunOutput | (() => Promise<PluginRunOutput>)): CheckProviderPlugin & { runs: number; db: string } {
  const p = { runs: 0, db: FRESH, probe: async () => ({ dbUpdatedAt: p.db }), run: async () => { p.runs++; return typeof output === 'function' ? output() : output; } };
  return p;
}
const base = (d: CheckDefinition, plugin: CheckProviderPlugin, extra: Record<string, unknown> = {}) =>
  ({ definition: d, plugin, sourceSha: SHA, scope: 'full', artifactDigest: 'sha256:1', workerProfile: 'scanner-v1', now: () => NOW, ...extra });

describe('check runner', () => {
  it('fake Trivy/Semgrep/custom providers satisfy gates and merge in one category', async () => {
    const a = await runCheck(base(def('fake-trivy'), fake(sarif())));
    const b = await runCheck(base(def('fake-semgrep'), fake({ format: 'json', dbUpdatedAt: FRESH, document: { findings: [{ id: 'GHSA-35jh-r3h4-6jhm', severity: 'high', package: 'lodash', ecosystem: 'npm', title: 'CVE-2021-23337' }] } })));
    const c = await runCheck(base(def('custom'), fake(clean)));
    expect([a.result.status, b.result.status, c.result.status]).toEqual(['fail', 'fail', 'pass']);
    const agg = aggregateCategory([a, b, c]);
    expect(agg.status).toBe('fail');
    expect(agg.findings).toHaveLength(1);
  });

  it('passes only a completed clean fresh run', async () => {
    expect((await runCheck(base(def('p'), fake(clean)))).result.status).toBe('pass');
  });

  it('maps a stale advisory DB through the policy to unknown, never pass', async () => {
    const r = await runCheck(base(def('p'), fake({ ...clean, dbUpdatedAt: '2026-11-01T00:00:00Z' })));
    expect(r.result).toMatchObject({ status: 'unknown', feed: 'stale' });
    const e = await runCheck(base(def('p', {}, { onFeedUnavailable: 'error' }), fake({ ...clean, dbUpdatedAt: '2026-11-01T00:00:00Z' })));
    expect(e.result.status).toBe('error');
  });

  it('treats a missing feed, crash, timeout and unparseable output as non-pass', async () => {
    const { dbUpdatedAt: _drop, ...noDb } = clean;
    expect((await runCheck(base(def('p'), fake(noDb)))).result).toMatchObject({ status: 'unknown', feed: 'unavailable' });
    expect((await runCheck(base(def('p'), fake(async () => { throw new Error('boom'); })))).result).toMatchObject({ status: 'error', execution: 'failed' });
    const hang = fake(() => new Promise<PluginRunOutput>(() => {}));
    expect((await runCheck(base(def('p', {}, { timeoutMs: 1000 }), hang))).result).toMatchObject({ status: 'error', execution: 'timeout' });
    expect((await runCheck(base(def('p'), fake({ format: 'sarif', dbUpdatedAt: FRESH, document: {} })))).result).toMatchObject({ status: 'error', execution: 'failed' });
  });

  it('refuses green for an untrusted scanner', async () => {
    const trustPolicy = { provider: 'p', reference: `reg/p@${DIGEST}`, pinnedDigest: DIGEST, signature: { required: true, trustedSigners: ['ok'] }, trustedSource: 'reg', updateProcess: 'pr', dbMaxAgeHours: 48 };
    const unsigned = await runCheck(base(def('p'), fake(clean), { trustPolicy }));
    expect(unsigned.result).toMatchObject({ status: 'fail' });
    const signed = await runCheck(base(def('p'), fake({ ...clean, observed: { signer: 'ok', digest: DIGEST } }), { trustPolicy }));
    expect(signed.result.status).toBe('pass');
  });

  it('caches and invalidates on every version dimension', async () => {
    const cache = new CheckResultCache();
    const plugin = fake(clean);
    const d = def('p');
    await runCheck(base(d, plugin, { cache }));
    expect((await runCheck(base(d, plugin, { cache }))).cacheHit).toBe(true);
    expect(plugin.runs).toBe(1);
    const variants: Array<[string, Record<string, unknown>, CheckDefinition?, string?]> = [
      ['sourceSha', { sourceSha: 'd'.repeat(40) }], ['scope', { scope: 'changed' }], ['artifact', { artifactDigest: 'sha256:2' }],
      ['worker', { workerProfile: 'scanner-v2' }], ['config', {}, def('p', {}, { timeoutMs: 2000 })],
      ['scanner version', {}, def('p', { provider: { name: 'p', version: '2.0.0', digest: DIGEST } })],
      ['scanner digest', {}, def('p', { provider: { name: 'p', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}` } })],
      ['db', {}, undefined, '2026-11-16T06:00:00Z'],
    ];
    for (const [name, extra, other, db] of variants) {
      const pl = fake(clean);
      if (db) pl.db = db;
      const hit = await runCheck(base(other ?? d, pl, { cache, ...extra }));
      expect(hit.cacheHit, name).toBe(false);
    }
  });

  it('does not cache failures or stale feeds', async () => {
    const cache = new CheckResultCache();
    await runCheck(base(def('p'), fake({ ...clean, dbUpdatedAt: '2026-11-01T00:00:00Z' }), { cache }));
    expect(cache.size).toBe(0);
  });
});
