import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkProviderConfigSchema, type CheckCategory } from './check-provider.js';
import { evaluateGates, planDueChecks, type CheckRunRecord } from './check-gates.js';
import { runCheck, type CheckProviderPlugin } from './check-runner.js';
import { BUILTIN_PROFILES, detectEcosystems, planChecks } from './capabilities.js';
import { analyzeDockerfile, analyzeTerraform, infraPlugin, infraPolicySchema } from './infra-policy.js';
import { evaluateExpression, licenseFindings, licensePlugin, licensePolicySchema } from './license-policy.js';
import { scorecardCheckDefinition, scorecardConfigSchema, scorecardPlugin } from './providers/scorecard-adapter.js';
import { recordSbom, sbomEvidenceEntry, validateSbom } from './sbom.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const SHA = 'c'.repeat(40);
const NOW = new Date('2026-11-16T12:00:00Z');

function def(name: string, category: CheckCategory, policy: Record<string, unknown> = {}) {
  return checkProviderConfigSchema.parse({ version: 1, checks: [{
    id: `${name}-${category}`, category, provider: { name, version: '1.0.0', digest: DIGEST }, scopes: ['full-repo'], triggers: ['pr-dev'],
    policy: { mandatory: true, timeoutMs: 1000, ...policy },
  }] }).checks[0]!;
}
const run = (d: ReturnType<typeof def>, plugin: CheckProviderPlugin) => runCheck({ definition: d, plugin, sourceSha: SHA, scope: 's', artifactDigest: 'x', workerProfile: 'w', now: () => NOW });
const gate = (category: CheckCategory, o: Awaited<ReturnType<typeof run>>, id: string, mandatory = true) => {
  const rec: CheckRunRecord = { checkId: id, category, result: o.result, sourceSha: SHA, finishedAt: NOW.toISOString(), findings: o.findings };
  return evaluateGates([{ category, mandatory, maxAgeHours: 24 }], [rec], { sourceSha: SHA, now: NOW });
};

const cdx = (components: unknown[]) => ({ bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: 'urn:uuid:1', metadata: { timestamp: '2026-11-16T00:00:00Z' }, components });
const comp = (name: string, license?: string) => ({ type: 'library', name, version: '1.0.0', purl: `pkg:npm/${name}@1.0.0`, ...(license ? { licenses: [{ license: { id: license } }] } : {}) });
const policy = licensePolicySchema.parse({ allow: ['MIT', 'Apache-2.0', 'BSD-3-Clause'], deny: ['GPL-3.0-only', 'AGPL-3.0-only'], review: ['MPL-2.0'] });

describe('SBOM schema and evidence', () => {
  it('validates CycloneDX and SPDX documents and extracts license info', () => {
    const v = validateSbom(cdx([comp('left-pad', 'MIT'), { type: 'library', name: 'dual', licenses: [{ expression: 'MIT OR GPL-3.0-only' }] }, comp('nolicense')]));
    expect(v).toMatchObject({ format: 'cyclonedx', specVersion: '1.5' });
    expect(v.components.map((c) => c.license)).toEqual(['MIT', 'MIT OR GPL-3.0-only', undefined]);
    const spdx = validateSbom({ spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT', name: 'x', documentNamespace: 'urn:x',
      creationInfo: { created: '2026-11-16T00:00:00Z', creators: ['Tool: t'] }, packages: [{ SPDXID: 'SPDXRef-1', name: 'a', licenseConcluded: 'NOASSERTION', licenseDeclared: 'MIT' }] });
    expect(spdx.components[0]?.license).toBe('MIT');
  });

  it('rejects malformed documents with the failing path', () => {
    expect(() => validateSbom({ bomFormat: 'CycloneDX', specVersion: '2.0', components: [] })).toThrow(/specVersion/);
    expect(() => validateSbom(cdx([{ type: 'library' }]))).toThrow(/name/);
    expect(() => validateSbom({ hello: 'world' })).toThrow(/unrecognized SBOM/);
  });

  it('records digest and provenance bound to the SHA and produces an evidence-manifest-compatible entry', () => {
    const doc = cdx([comp('a', 'MIT')]);
    const a = recordSbom(doc, { sourceSha: SHA, generator: { name: 'syft', version: '1.0' }, generatedAt: '2026-11-16T00:00:00Z' });
    expect(a.provenance).toMatchObject({ sourceSha: SHA, format: 'cyclonedx', componentCount: 1, generator: { name: 'syft' } });
    expect(a.provenance.sha256).toMatch(/^[a-f0-9]{64}$/);
    const reordered = recordSbom({ components: doc.components, specVersion: '1.5', bomFormat: 'CycloneDX', metadata: doc.metadata, serialNumber: 'urn:uuid:1' }, { sourceSha: SHA, generator: { name: 'syft', version: '1.0' }, generatedAt: '2026-11-16T00:00:00Z' });
    expect(reordered.provenance.sha256).toBe(a.provenance.sha256); // canonical JSON
    expect(() => recordSbom(doc, { sourceSha: 'main', generator: { name: 'x', version: '1' }, generatedAt: NOW.toISOString() })).toThrow(/full source SHA/);
    const entry = sbomEvidenceEntry(a, 'artifacts/sbom.cdx.json');
    const schema = JSON.parse(readFileSync(new URL('../../../../../../../schemas/evidence-manifest.schema.json', import.meta.url), 'utf8'));
    const item = schema.properties.artifacts.items;
    expect(Object.keys(entry).every((k) => k in item.properties)).toBe(true);
    expect(item.required.every((k: string) => k in entry)).toBe(true);
    expect(entry).toMatchObject({ kind: 'artifact', mediaType: 'application/vnd.cyclonedx+json', sha256: a.provenance.sha256 });
  });
});

describe('license policy', () => {
  it('evaluates SPDX expressions: OR takes the best, AND the worst, WITH keeps the base id', () => {
    const e = (x: string) => evaluateExpression(x, policy);
    expect(e('MIT')).toBe('allowed');
    expect(e('GPL-3.0-only')).toBe('denied');
    expect(e('MIT OR GPL-3.0-only')).toBe('allowed');
    expect(e('MIT AND GPL-3.0-only')).toBe('denied');
    expect(e('(MIT OR MPL-2.0) AND Apache-2.0')).toBe('allowed');
    expect(e('MPL-2.0')).toBe('review');
    expect(e('Apache-2.0 WITH LLVM-exception')).toBe('allowed');
    expect(e('SomethingOdd-1.0')).toBe('unknown');
    expect(e('MIT AND')).not.toBe('allowed');
  });

  it('a denied license is a blocking finding; review and unknown are not blocking by default', async () => {
    const comps = validateSbom(cdx([comp('ok', 'MIT'), comp('copyleft', 'GPL-3.0-only'), comp('weak', 'MPL-2.0'), comp('mystery')])).components;
    const d = def('license', 'license');
    const o = await run(d, licensePlugin({ policy, readComponents: async () => comps, now: () => NOW }));
    expect(o.result).toMatchObject({ status: 'fail', blockingFindingCount: 1, findingCount: 3 });
    expect(o.findings.find((f) => f.severity === 'high')?.dependency?.name).toBe('copyleft');
    expect(new Set(o.findings.map((f) => f.fingerprint)).size).toBe(3); // one finding per package, not per license
    expect(gate('license', o, d.id).allowed).toBe(false);
  });

  it('review-only and unknown licenses warn without blocking; policy can make unknown block', async () => {
    const comps = validateSbom(cdx([comp('weak', 'MPL-2.0'), comp('mystery')])).components;
    const o = await run(def('license', 'license'), licensePlugin({ policy, readComponents: async () => comps, now: () => NOW }));
    expect(o.result.status).toBe('warn');
    const strict = licensePolicySchema.parse({ ...policy, unknown: 'deny' });
    const s = await run(def('license', 'license'), licensePlugin({ policy: strict, readComponents: async () => comps, now: () => NOW }));
    expect(s.result.status).toBe('fail');
  });

  it('reviewed, expiring per-package exceptions apply; conflicting lists are rejected; an empty SBOM is not a silent pass', async () => {
    const withException = licensePolicySchema.parse({ ...policy, exceptions: [{ package: 'copyleft', license: 'GPL-3.0-only', reason: 'dev-only tool', expiresAt: '2026-12-01T00:00:00Z' }] });
    expect(licenseFindings([{ name: 'copyleft', license: 'GPL-3.0-only' }], withException, NOW).findings).toHaveLength(0);
    expect(licenseFindings([{ name: 'copyleft', license: 'GPL-3.0-only' }], withException, new Date('2026-12-02T00:00:00Z')).findings).toHaveLength(1);
    expect(licensePolicySchema.safeParse({ allow: ['MIT'], deny: ['MIT'] }).success).toBe(false);
    const empty = await run(def('license', 'license'), licensePlugin({ policy, readComponents: async () => [] }));
    expect(empty.result.status).toBe('unknown');
  });
});

describe('container and IaC policy', () => {
  const p = infraPolicySchema.parse({});

  it('flags an unpinned or latest base image and accepts a digest-pinned one', () => {
    const ids = (t: string) => analyzeDockerfile('Dockerfile', t, p).map((f) => f.id);
    expect(ids('FROM node:latest\nUSER app\n')).toEqual(['container.unpinned-base-image']);
    expect(ids('FROM node\nUSER app\n')).toEqual(['container.unpinned-base-image']);
    expect(ids('FROM node:20\nUSER app\n')).toEqual(['container.base-image-not-digest-pinned']);
    expect(ids(`FROM node:20@sha256:${'b'.repeat(64)}\nUSER app\n`)).toEqual([]);
    expect(ids('FROM scratch\nUSER 1000\n')).toEqual([]);
  });

  it('multi-stage builds, root users, remote ADD and untrusted registries', () => {
    const multi = `FROM node:20@sha256:${'b'.repeat(64)} AS build\nRUN x\nFROM build\nADD https://example.org/x.tgz /x\n`;
    expect(analyzeDockerfile('Dockerfile', multi, p).map((f) => f.id)).toEqual(['container.remote-add', 'container.runs-as-root']);
    const trusted = infraPolicySchema.parse({ trustedRegistries: ['registry.example.org'], requireDigest: false });
    expect(analyzeDockerfile('Dockerfile', 'FROM docker.io/library/node:20\nUSER app\n', trusted).map((f) => f.id)).toEqual(['container.untrusted-registry']);
    expect(analyzeDockerfile('Dockerfile', 'FROM registry.example.org/team/base:1.2\nUSER app\n', trusted)).toEqual([]);
  });

  it('flags the high-value Terraform patterns with line numbers and ignores comments', () => {
    const tf = [
      'resource "aws_s3_bucket" "b" {', '  acl = "public-read"', '}',
      '# acl = "public-read"',
      'resource "aws_security_group_rule" "ssh" {', '  from_port = 22', '  to_port = 22', '  cidr_blocks = ["0.0.0.0/0"]', '}',
      'resource "aws_db_instance" "d" {', '  publicly_accessible = true', '  storage_encrypted = false', '}',
    ].join('\n');
    const f = analyzeTerraform('main.tf', tf, p);
    expect(f.map((x) => [x.id, x.line])).toEqual([['iac.public-bucket-acl', 2], ['iac.open-to-world', 8], ['iac.public-database', 11], ['iac.unencrypted-storage', 12]]);
    expect(analyzeTerraform('a.tf', 'cidr_blocks = ["0.0.0.0/0"]\nfrom_port = 443\n', p)[0]?.id).toBe('iac.broad-cidr');
  });

  it('an unpinned base image becomes a finding through runCheck and the gates; no Dockerfile is NOT_APPLICABLE', async () => {
    const d = def('infra', 'container');
    const o = await run(d, infraPlugin({ domain: 'container', policy: p, readFiles: async () => [{ path: 'svc/Dockerfile', text: 'FROM node:latest\nUSER app\n' }] }));
    expect(o.result).toMatchObject({ status: 'fail', blockingFindingCount: 1 });
    expect(gate('container', o, d.id).allowed).toBe(false);
    const plan = planChecks({ id: 'x', description: 'x', checks: [{ id: 'container-policy', category: 'container', ecosystem: 'container', tool: 'builtin' }] }, detectEcosystems(['src/a.ts']), () => true);
    expect(plan[0]).toMatchObject({ action: 'not-applicable', reason: 'ecosystem-absent' });
    expect(BUILTIN_PROFILES.length).toBeGreaterThan(0);
    const none = await run(def('infra', 'iac'), infraPlugin({ domain: 'iac', policy: p, readFiles: async () => [{ path: 'src/a.ts', text: '' }] }));
    expect(none.result.status).toBe('unknown');
  });
});

describe('OpenSSF Scorecard (report-only, opt-in)', () => {
  const report = JSON.stringify({ date: '2026-11-15', repo: { name: 'github.com/o/r', commit: SHA }, scorecard: { version: 'v5.0.0' }, score: 4.2,
    checks: [{ name: 'Code-Review', score: 2, reason: 'few reviews' }, { name: 'Pinned-Dependencies', score: 9 }, { name: 'Fuzzing', score: -1 }] });

  it('is disabled by default: zero scorecard calls and an explicit reason', async () => {
    const cfg = scorecardConfigSchema.parse({});
    expect(cfg.enabled).toBe(false);
    let calls = 0;
    const o = await run(def('scorecard', 'custom'), scorecardPlugin({ config: cfg, repo: 'github.com/o/r', exec: async () => { calls++; return { exitCode: 0, stdout: report }; } }));
    expect(calls).toBe(0);
    expect(o.result.reason).toMatch(/disabled/);
    expect(() => scorecardCheckDefinition(cfg, { version: '5', digest: DIGEST })).toThrow(/disabled/);
  });

  it('records the result with provenance but can never block a release', async () => {
    const cfg = scorecardConfigSchema.parse({ enabled: true });
    const records: unknown[] = [];
    const d = scorecardCheckDefinition(cfg, { version: 'v5.0.0', digest: DIGEST });
    const o = await run(d, scorecardPlugin({ config: cfg, repo: 'github.com/o/r', exec: async () => ({ exitCode: 0, stdout: report }), onRecord: (r) => records.push(r) }));
    expect(records[0]).toMatchObject({ repo: 'github.com/o/r', commit: SHA, score: 4.2, scorecardVersion: 'v5.0.0', lowChecks: [{ name: 'Code-Review', score: 2 }] });
    expect(o.result).toMatchObject({ status: 'warn', blockingFindingCount: 0 });
    expect(o.findings.every((f) => f.severity === 'low')).toBe(true); // -1 (not evaluated) is not a finding
    expect(gate('custom', o, d.id).allowed).toBe(true);
    expect(d.policy.mandatory).toBe(false);
  });

  it('a crash or malformed report is not a pass; the schedule entry is independent and periodic', async () => {
    const cfg = scorecardConfigSchema.parse({ enabled: true, cadence: 'weekly', timezone: 'America/Detroit' });
    const d = scorecardCheckDefinition(cfg, { version: 'v5.0.0', digest: DIGEST });
    expect((await run(d, scorecardPlugin({ config: cfg, repo: 'r', exec: async () => ({ exitCode: 1, stdout: '' }) }))).result.status).toBe('unknown');
    expect((await run(d, scorecardPlugin({ config: cfg, repo: 'r', exec: async () => ({ exitCode: 0, stdout: '{}' }) }))).result.status).toBe('unknown');
    expect(d.triggers).toEqual(['periodic-independent', 'manual']);
    expect(planDueChecks([d], {}, 'periodic-independent', NOW)).toEqual([{ checkId: 'openssf-scorecard', trigger: 'periodic-independent' }]);
    expect(planDueChecks([d], { 'openssf-scorecard': '2026-11-15T00:00:00Z' }, 'periodic-independent', NOW)).toEqual([]);
  });
});
