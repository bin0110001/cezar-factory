import { describe, expect, it } from 'vitest';
import { checkProviderConfigSchema, type CheckCategory } from '../check-provider.js';
import { CheckResultCache, runCheck } from '../check-runner.js';
import { queryFindings } from '../normalized-findings.js';
import { reconcileRuns } from '../reconcile.js';
import { buildTrivyArgv, trivyPlugin, TRIVY_DOMAINS, type TrivyDomain } from './trivy-adapter.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const NOW = new Date('2026-11-16T12:00:00Z');
const FRESH = '2026-11-16T00:00:00Z';
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const PLANTED = 'fixture-planted-value-0123456789';

const vuln = (over: Record<string, unknown> = {}) => ({ VulnerabilityID: 'CVE-2021-23337', PkgName: 'lodash', InstalledVersion: '4.17.20', FixedVersion: '4.17.21', Severity: 'HIGH', Title: 'command injection', PrimaryURL: 'https://avd.example/CVE-2021-23337', ...over });
const report = (vulns: unknown[]) => ({ SchemaVersion: 2, Results: [{ Target: 'package-lock.json', Class: 'lang-pkgs', Type: 'npm', Vulnerabilities: vulns }] });

function run(domain: TrivyDomain, json: unknown, over: { exitCode?: number; stdout?: string; secrets?: string[]; cache?: CheckResultCache } = {}) {
  const category: CheckCategory = TRIVY_DOMAINS[domain].category;
  const definition = checkProviderConfigSchema.parse({ version: 1, checks: [{
    id: `trivy-${domain}`, category, provider: { name: 'trivy', version: '0.60.0', digest: DIGEST }, scopes: ['full-repo'], triggers: ['pr-dev'],
    policy: { mandatory: true, timeoutMs: 1000, maxAgeHours: 48, cache: { enabled: true, ttlHours: 24 } },
  }] }).checks[0];
  let execs = 0;
  const plugin = trivyPlugin({
    domain, target: '/src', readDbUpdatedAt: async () => FRESH,
    exec: async () => { execs++; return { exitCode: over.exitCode ?? 0, stdout: over.stdout ?? JSON.stringify(json) }; },
  });
  return runCheck({ definition, plugin, sourceSha: 'c'.repeat(40), scope: 's', artifactDigest: 'x', workerProfile: 'w', now: () => NOW, secrets: over.secrets, cache: over.cache }).then((o) => ({ ...o, execs: () => execs }));
}

describe('trivy argv', () => {
  it('enables each domain independently and can emit an SBOM', () => {
    expect(buildTrivyArgv({ domain: 'repository', target: '/src' })).toEqual(['trivy', 'fs', '--quiet', '--format', 'json', '--scanners', 'vuln', '--', '/src']);
    expect(buildTrivyArgv({ domain: 'image', target: 'img@sha256:x' }).slice(0, 2)).toEqual(['trivy', 'image']);
    expect(buildTrivyArgv({ domain: 'misconfiguration', target: '/src' })).not.toContain('--scanners');
    expect(buildTrivyArgv({ domain: 'secret', target: '/src' })).toContain('secret');
    expect(buildTrivyArgv({ domain: 'repository', target: '/src', sbom: true })).toContain('cyclonedx');
    expect(buildTrivyArgv({ domain: 'repository', target: '--evil' }).slice(-2)).toEqual(['--', '--evil']);
  });
});

describe('trivy adapter fixtures', () => {
  it('confirmed CVE blocks with the shared fingerprint and fix info', async () => {
    const o = await run('repository', report([vuln()]));
    expect(o.result).toMatchObject({ status: 'fail', blockingFindingCount: 1 });
    expect(o.findings[0]).toMatchObject({ commonIds: { cve: ['CVE-2021-23337'] }, fix: { available: true, version: '4.17.21' }, dependency: { name: 'lodash', ecosystem: 'npm' } });
  });
  it('a false positive (not_affected) is waived and does not block', async () => {
    const o = await run('repository', report([vuln({ Status: 'not_affected' })]));
    expect(o.result.status).toBe('pass');
    expect(queryFindings(o.findings)).toHaveLength(0);
  });
  it('no lockfile is unknown with a reason, never a silent pass', async () => {
    const o = await run('repository', { SchemaVersion: 2 });
    expect(o.result).toMatchObject({ status: 'unknown', execution: 'not-run', feed: 'not-applicable' });
    expect(o.result.reason).toMatch(/lockfile/);
  });
  it('a scanned lockfile with no vulnerabilities is a real pass', async () => {
    expect((await run('repository', report([]))).result.status).toBe('pass');
  });
  it('secrets in scanner output never reach stored findings', async () => {
    const o = await run('repository', report([vuln({ Title: `leaks ${SECRET} and ${PLANTED}` })]), { secrets: [PLANTED] });
    const text = JSON.stringify(o);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(PLANTED);
  });
  it('secret domain findings omit the matched text', async () => {
    const o = await run('secret', { Results: [{ Target: '.env', Class: 'secret', Secrets: [{ RuleID: 'github-pat', Title: 'GitHub PAT', Severity: 'CRITICAL', StartLine: 3, Match: `TOKEN=${PLANTED}` }] }] });
    expect(JSON.stringify(o)).not.toContain(PLANTED);
    expect(o.result.status).toBe('fail');
  });
  it('non-zero exit, bad JSON and malformed reports are errors, not passes', async () => {
    expect((await run('repository', {}, { exitCode: 2 })).result.status).toBe('error');
    expect((await run('repository', {}, { stdout: 'not json' })).result.status).toBe('error');
    expect((await run('repository', { Results: 'nope' })).result.status).toBe('error');
  });
  it('image and repository scans run separately and the cache avoids a redundant scan', async () => {
    const cache = new CheckResultCache();
    const first = await run('repository', report([]), { cache });
    const second = await run('repository', report([]), { cache });
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect((await run('image', report([vuln()]), { cache })).result.checkId).toBe('trivy-image');
  });
});

describe('reconciliation across runs', () => {
  it('opens, keeps and fixes findings by common fingerprint; an unusable run fixes nothing', async () => {
    const run1 = await run('repository', report([vuln(), vuln({ VulnerabilityID: 'CVE-2022-0001', PkgName: 'minimist' })]));
    const run2 = await run('repository', report([vuln()]));
    const r = reconcileRuns(run1.findings, run2.findings, true);
    expect(r.stillOpen).toHaveLength(1);
    expect(r.fixed.map((f) => f.dependency?.name)).toEqual(['minimist']);
    expect(r.opened).toHaveLength(0);
    expect(reconcileRuns(run1.findings, [], false).fixed).toEqual([]);
  });
});
