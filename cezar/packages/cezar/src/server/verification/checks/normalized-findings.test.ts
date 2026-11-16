import { describe, expect, it } from 'vitest';
import { mergeByFingerprint, normalizeGenericJson, normalizeSarif, queryFindings, type NormalizeContext } from './normalized-findings.js';

const SHA = 'a'.repeat(40);
const ctx = (name: string, over: Partial<NormalizeContext> = {}): NormalizeContext => ({
  provider: { name, version: '1.0.0', digest: `sha256:${'b'.repeat(64)}` }, category: 'sca', sourceSha: SHA, env: {}, ...over,
});
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

// Trivy-shaped and Semgrep-shaped fake SARIF; the same vulnerability reported with different rule ids.
const trivy = (msg = 'lodash 4.17.20 is vulnerable') => ({ runs: [{ tool: { driver: { name: 'x', rules: [{ id: 'CVE-2021-23337', helpUri: 'https://example.org/a', properties: { severity: 'HIGH', packageName: 'lodash', ecosystem: 'npm', installedVersion: '4.17.20', fixedVersion: '4.17.21' } }] } },
  results: [{ ruleId: 'CVE-2021-23337', level: 'error', message: { text: msg }, partialFingerprints: { primaryLocationLineHash: 'trivy-fp-1' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'package-lock.json' }, region: { startLine: 3 } } }] }] }] });
const osvShaped = { findings: [{ id: 'GHSA-35jh-r3h4-6jhm', severity: 'high', package: 'lodash', ecosystem: 'npm', version: '4.17.20', fixedVersion: '4.17.21', title: 'Command injection (CVE-2021-23337)', fingerprint: 'osv-fp-9', path: 'package-lock.json' }] };

describe('normalizers', () => {
  it('maps SARIF and generic JSON to identical query results (provider swap)', () => {
    const a = normalizeSarif(trivy(), ctx('fake-trivy'));
    const b = normalizeGenericJson(osvShaped, ctx('fake-osv'));
    expect(a[0].fingerprint).toBe(b[0].fingerprint);
    expect(queryFindings(a, { commonId: 'cve-2021-23337' })).toHaveLength(1);
    expect(a[0]).toMatchObject({ severity: 'high', fix: { available: true, version: '4.17.21' }, dependency: { name: 'lodash' } });
    expect(a[0].commonIds.cve).toEqual(['CVE-2021-23337']);
  });
  it('keeps history across a provider swap and retains every source fingerprint', () => {
    const merged = mergeByFingerprint(normalizeSarif(trivy(), ctx('fake-trivy')), normalizeGenericJson(osvShaped, ctx('fake-osv')));
    expect(merged).toHaveLength(1);
    expect(merged[0].sourceFingerprints.map((s) => s.provider).sort()).toEqual(['fake-osv', 'fake-trivy']);
  });
  it('never stores a planted secret', () => {
    const planted = 'fixture-planted-value-0123456789';
    const out = normalizeSarif(trivy(`token ${SECRET} and ${planted}`), ctx('fake-trivy', { secrets: [planted] }));
    const text = JSON.stringify(out);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(planted);
    expect(text).toContain('[REDACTED]');
  });
  it('rejects malformed documents instead of yielding zero findings', () => {
    expect(() => normalizeSarif({}, ctx('x'))).toThrow(/runs/);
    expect(() => normalizeGenericJson({ results: [] }, ctx('x'))).toThrow(/findings/);
  });
  it('honours suppressions as waivers and query filters', () => {
    const doc = trivy();
    (doc.runs[0].results[0] as Record<string, unknown>).suppressions = [{ kind: 'inSource' }];
    const f = normalizeSarif(doc, ctx('fake-trivy'));
    expect(f[0].waiver.status).toBe('false-positive');
    expect(queryFindings(f)).toHaveLength(0);
    expect(queryFindings(f, { includeWaived: true })).toHaveLength(1);
  });
  it('uses category, CWE and path identity for rule findings', () => {
    const sast = (rule: string) => normalizeSarif({ runs: [{ results: [{ ruleId: rule, level: 'warning', message: { text: 'xss CWE-79' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/a.ts' } } }] }] }] }, ctx('p', { category: 'sast' }))[0];
    expect(sast('rule-a').fingerprint).toBe(sast('other-provider-rule').fingerprint);
  });
});
