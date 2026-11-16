import { describe, expect, it } from 'vitest';
import { checkProviderConfigSchema, type CheckDefinition } from '../check-provider.js';
import { evaluateGates, type CheckRunRecord } from '../check-gates.js';
import { runCheck, type CheckProviderPlugin } from '../check-runner.js';
import { osvPlugin } from './osv-adapter.js';
import { trivyPlugin } from './trivy-adapter.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const NOW = new Date('2026-11-16T12:00:00Z');
const FRESH = '2026-11-16T00:00:00Z';
const SHA = 'c'.repeat(40);
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const PLANTED = 'fixture-planted-value-0123456789';

interface Fixture { name: string; trivy: { exitCode: number; json: unknown }; osv: { exitCode: number; json: unknown }; status: string; blocking: number }

const trivyVuln = (extra: Record<string, unknown> = {}) => ({ Target: 'package-lock.json', Class: 'lang-pkgs', Type: 'npm', Vulnerabilities: [{ VulnerabilityID: 'CVE-2021-23337', PkgName: 'lodash', InstalledVersion: '4.17.20', FixedVersion: '4.17.21', Severity: 'HIGH', Title: 'command injection', ...extra }] });
const osvVuln = (summary = 'command injection') => ({ results: [{ source: { path: 'package-lock.json', type: 'lockfile' }, packages: [{ package: { name: 'lodash', version: '4.17.20', ecosystem: 'npm' },
  vulnerabilities: [{ id: 'GHSA-35jh-r3h4-6jhm', aliases: ['CVE-2021-23337'], summary, affected: [{ package: { name: 'lodash' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }] }], groups: [{ ids: ['GHSA-35jh-r3h4-6jhm'], max_severity: '7.2' }] }] }] });

const fixtures: Fixture[] = [
  { name: 'confirmed CVE', trivy: { exitCode: 0, json: { Results: [trivyVuln()] } }, osv: { exitCode: 1, json: osvVuln() }, status: 'fail', blocking: 1 },
  { name: 'false positive suppressed', trivy: { exitCode: 0, json: { Results: [trivyVuln({ Status: 'not_affected' })] } }, osv: { exitCode: 0, json: { results: [{ source: { path: 'package-lock.json' }, packages: [] }] } }, status: 'pass', blocking: 0 },
  { name: 'clean lockfile', trivy: { exitCode: 0, json: { Results: [{ Target: 'package-lock.json', Class: 'lang-pkgs', Type: 'npm', Vulnerabilities: null }] } }, osv: { exitCode: 0, json: { results: [{ source: { path: 'package-lock.json' }, packages: [] }] } }, status: 'pass', blocking: 0 },
  { name: 'no lockfile', trivy: { exitCode: 0, json: {} }, osv: { exitCode: 128, json: {} }, status: 'unknown', blocking: 0 },
  { name: 'planted secret in output', trivy: { exitCode: 0, json: { Results: [trivyVuln({ Title: `leak ${SECRET} ${PLANTED}` })] } }, osv: { exitCode: 1, json: osvVuln(`leak ${SECRET} ${PLANTED}`) }, status: 'fail', blocking: 1 },
];

type Make = (fx: Fixture) => CheckProviderPlugin;
const providers: Array<{ name: string; make: Make }> = [
  { name: 'trivy', make: (fx) => trivyPlugin({ domain: 'repository', target: '/src', readDbUpdatedAt: async () => FRESH, exec: async () => ({ exitCode: fx.trivy.exitCode, stdout: JSON.stringify(fx.trivy.json) }) }) },
  { name: 'osv-scanner', make: (fx) => osvPlugin({ domain: 'repository', target: '/src', readDbUpdatedAt: async () => FRESH, exec: async () => ({ exitCode: fx.osv.exitCode, stdout: JSON.stringify(fx.osv.json) }) }) },
];

// The definition differs between providers only in `provider.name`: that is the whole "config" of a swap.
const definition = (provider: string): CheckDefinition => checkProviderConfigSchema.parse({ version: 1, checks: [{
  id: 'sca-main', category: 'sca', provider: { name: provider, version: '1.0.0', digest: DIGEST }, scopes: ['full-repo'], triggers: ['pr-dev'],
  policy: { mandatory: true, timeoutMs: 1000, maxAgeHours: 48 },
}] }).checks[0];

async function runFixture(p: { name: string; make: Make }, fx: Fixture) {
  const d = definition(p.name);
  const o = await runCheck({ definition: d, plugin: p.make(fx), sourceSha: SHA, scope: 's', artifactDigest: 'x', workerProfile: 'w', now: () => NOW, secrets: [PLANTED] });
  const record: CheckRunRecord = { checkId: d.id, category: d.category, result: o.result, sourceSha: SHA, finishedAt: NOW.toISOString(), findings: o.findings };
  return { o, gate: evaluateGates([{ category: 'sca', mandatory: true, maxAgeHours: 24 }], [record], { sourceSha: SHA, now: NOW }) };
}

describe.each(providers)('shared fixture suite: $name', (p) => {
  it.each(fixtures)('$name', async (fx) => {
    const { o } = await runFixture(p, fx);
    expect(o.result.status).toBe(fx.status);
    expect(o.result.blockingFindingCount).toBe(fx.blocking);
    expect(JSON.stringify(o)).not.toContain(SECRET);
    expect(JSON.stringify(o)).not.toContain(PLANTED);
  });
  it('treats a crash and non-JSON as an error, never a pass', async () => {
    expect((await runFixture(p, { ...fixtures[2], trivy: { exitCode: 2, json: {} }, osv: { exitCode: 2, json: {} } })).o.result.status).toBe('error');
  });
});

describe('provider swap by config only', () => {
  it('yields the same status, fingerprints and gate verdicts for either provider', async () => {
    for (const fx of fixtures) {
      const [a, b] = await Promise.all(providers.map((p) => runFixture(p, fx)));
      expect(a.o.result.status, fx.name).toBe(b.o.result.status);
      const active = (r: typeof a) => r.o.findings.filter((f) => f.waiver.status === 'none').map((f) => f.fingerprint);
      expect(active(a), fx.name).toEqual(active(b));
      expect(a.gate, fx.name).toEqual(b.gate);
    }
  });
});
