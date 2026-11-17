import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { qualityDryRunResponseSchema, waiverRequestSchema, waiverResponseSchema, type WaiverRequest } from '@open-mercato/cezar-contract';
import { buildReleaseCandidates } from './read-model.ts';
import { dryRunPolicy, effectivePolicy, evaluateWaiver, isBlocking, maxWaiverDays, recordWaiver, specOf, validateQualityPolicy } from './quality-actions.ts';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const NOW = new Date('2026-11-16T12:00:00Z');
const fixtures = JSON.parse(readFileSync(new URL('../../../../../tests/fixtures/quality-gate-cases.json', import.meta.url), 'utf8')) as {
  documents: Record<string, { doc: Record<string, unknown>; project: string | null; repoType: string | null; rows: Array<{ category: string; stage: string; level: string; onUnavailable: string; blocks: Record<string, boolean> }> }>;
};
const shipped = JSON.parse(readFileSync(new URL('../../../../../policies/quality-gates.json', import.meta.url), 'utf8')) as Record<string, unknown>;

describe('parity with the Python authority (shared fixture)', () => {
  for (const [name, d] of Object.entries(fixtures.documents)) {
    it(`${name}: every category, stage and status agrees (${d.rows.length} rows)`, () => {
      const eff = effectivePolicy(d.doc, d.project, d.repoType);
      for (const row of d.rows) {
        const spec = specOf(eff, row.category, row.stage);
        expect([row.category, row.stage, spec.level, spec.onUnavailable]).toEqual([row.category, row.stage, row.level, row.onUnavailable]);
        for (const [status, blocks] of Object.entries(row.blocks)) expect(isBlocking(eff, row.category, row.stage, status), `${row.category}@${row.stage} ${status}`).toBe(blocks);
      }
    });
  }
});

const sha = (c: string) => c.repeat(40);
const candidate = (id: string, matrix: unknown[] = [], over: Record<string, unknown> = {}) => ({
  id, state: 'validating', revision: 1, devSha: sha('a'), baseStableSha: sha('b'), candidateSha: null, configHash: `sha256:${'d'.repeat(64)}`,
  createdAt: '2026-11-16T08:00:00Z', updatedAt: '2026-11-16T11:00:00Z', lease: { owner: 'w', expiresAt: '2099-01-01T00:00:00Z', stale: false },
  tests: { status: 'running', shards: { total: 1, passed: 0, failed: 0 }, assetVersion: null }, devDrift: { commitsAhead: 0, newestDevSha: null },
  blockers: [], repairObligations: [], receipts: [], pending: { count: 0, coalescedReason: null, triggers: [] }, nextScheduledAttempt: null,
  links: { pullRequests: [], issues: [] }, warnings: [], checkMatrix: matrix, ...over,
});
const row = (category: string, status: string, feed = 'fresh') => ({ category, status, blocking: false, newFindings: 0, knownFindings: 0, provider: null, feed, scope: null, sbomDigest: null, activeWaivers: 0 });
const model = (cands: unknown[]) => buildReleaseCandidates({ snapshotAt: '2026-11-16T11:59:00Z', projects: { p: { candidates: cands } } }, NOW);

describe('dry run of the check policy against the last candidate', () => {
  const stage = (r: ReturnType<typeof dryRunPolicy>, s: string) => r.stages.find((x) => x.stage === s)!;

  it('shows what the policy would do at every stage, and distinguishes a failed scan from a confirmed blocking CVE', () => {
    const failedScan = dryRunPolicy(model([candidate('c1', [row('sca', 'error', 'unavailable'), row('test', 'pass'), row('secrets', 'pass')])]), { projectId: 'p', policy: shipped });
    const confirmed = dryRunPolicy(model([candidate('c1', [row('sca', 'fail'), row('test', 'pass'), row('secrets', 'pass')])]), { projectId: 'p', policy: shipped });
    expect(qualityDryRunResponseSchema.safeParse(failedScan).success).toBe(true);
    const a = stage(failedScan, 'stable').checks.find((c) => c.category === 'sca')!;
    const b = stage(confirmed, 'stable').checks.find((c) => c.category === 'sca')!;
    expect([a.status, a.blocks]).toEqual(['error', true]);      // an outage blocks because the check fails closed
    expect([b.status, b.blocks]).toEqual(['fail', true]);       // a real finding blocks because it is required
    expect(a.status).not.toBe(b.status);                        // and the operator can tell them apart
    expect(failedScan.warnings.join(' ')).toContain('fail closed rather than pass');
    expect(stage(failedScan, 'pr-dev').wouldBlock).toBe(false); // advisory at PR time
  });

  it('a stale or missing advisory result never passes a required security check', () => {
    const r = dryRunPolicy(model([candidate('c1', [row('test', 'pass'), row('secrets', 'pass')])]), { projectId: 'p', policy: shipped });
    const sca = stage(r, 'stable').checks.find((c) => c.category === 'sca')!;
    expect(sca).toMatchObject({ status: 'unknown', blocks: true });
    expect(sca.note).toContain('no result');
    expect(stage(r, 'stable').wouldBlock).toBe(true);
  });

  it('a policy change is previewed without saving anything, and an invalid one is refused with paths', () => {
    const lenient = structuredClone(shipped) as { defaults: { checks: Record<string, Record<string, unknown>> } };
    lenient.defaults.checks.sca!.stable = { level: 'advisory' };
    const matrix = [row('sca', 'fail'), row('test', 'pass'), row('secrets', 'pass')];
    expect(stage(dryRunPolicy(model([candidate('c1', matrix)]), { projectId: 'p', policy: lenient }), 'stable').wouldBlock).toBe(false);
    const bad = structuredClone(shipped) as { defaults: { checks: Record<string, Record<string, unknown>> } };
    bad.defaults.checks.sca!.stable = { level: 'required', onUnavailable: 'fail-open' };
    const r = dryRunPolicy(model([candidate('c1', matrix)]), { projectId: 'p', policy: bad });
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain('defaults.checks.sca.stable.onUnavailable');
    expect(validateQualityPolicy({ schemaVersion: 'nope' })[0]).toContain('schemaVersion');
  });

  it('reports the recorded compute cost as an estimate and says so when none was recorded; uses the active candidate else the latest', () => {
    const withCost = dryRunPolicy(model([candidate('c2', [], { cost: { computeSeconds: 5400 } })]), { projectId: 'p', policy: shipped });
    expect(withCost.estimate).toEqual({ computeHours: 1.5, basis: 'recorded compute cost of c2' });
    expect(dryRunPolicy(model([candidate('c3')]), { projectId: 'p', policy: shipped }).estimate.computeHours).toBeNull();
    const done = model([candidate('old', [row('sca', 'pass')], { state: 'promoted', updatedAt: '2026-11-10T00:00:00Z', lease: { owner: null, expiresAt: null, stale: false } })]);
    expect(dryRunPolicy(done, { projectId: 'p', policy: shipped }).candidateId).toBe('old');
    const none = dryRunPolicy(model([]), { projectId: 'p', policy: shipped });
    expect(none.candidateId).toBeNull();
    expect(none.warnings[0]).toContain('no candidate yet');
  });
});

describe('review-only waiver request', () => {
  const req = (over: Partial<WaiverRequest> = {}): WaiverRequest => ({ projectId: 'p', fingerprint: 'a'.repeat(64), stages: ['stable'], reason: 'vendor patch lands next week', expiresInDays: 14, ...over });
  const m = model([candidate('c1')]);
  const local = { localHandoff: true, maxDays: 30 };

  it('names what it covers, expires, and has a real reason: blanket and unbounded waivers are not expressible', () => {
    expect(waiverRequestSchema.safeParse(req()).success).toBe(true);
    expect(waiverRequestSchema.safeParse(req({ fingerprint: undefined })).success).toBe(false);
    expect(waiverRequestSchema.safeParse(req({ fingerprint: undefined, advisoryId: 'CVE-2026-0001' })).success).toBe(true);
    for (const bad of [{ reason: 'short' }, { expiresInDays: 0 }, { expiresInDays: 400 }, { stages: [] }, { extra: 1 }]) expect(waiverRequestSchema.safeParse({ ...req(), ...bad }).success).toBe(false);
  });

  it('is local only, needs a snapshot and a known project and candidate, and respects the policy maximum', () => {
    expect(evaluateWaiver(m, req(), { localHandoff: false, maxDays: 30 })).toMatchObject({ ok: false, status: 403 });
    expect(evaluateWaiver(buildReleaseCandidates(undefined, NOW), req(), local)).toMatchObject({ ok: false, status: 409 });
    expect(evaluateWaiver(m, req({ projectId: 'ghost' }), local)).toMatchObject({ ok: false, status: 404 });
    expect(evaluateWaiver(m, req({ candidateId: 'nope' }), local)).toMatchObject({ ok: false, status: 404 });
    expect(evaluateWaiver(m, req({ expiresInDays: 60 }), local)).toMatchObject({ ok: false, status: 400 });
    expect(evaluateWaiver(m, req({ candidateId: 'c1' }), local)).toEqual({ ok: true, maxDays: 30 });
    expect(maxWaiverDays(shipped, null, null)).toBe(30);
    expect(maxWaiverDays({ defaults: {} }, null, null)).toBe(30);
  });

  it('records one audited, redacted request with an expiry and queues it for the engine', () => {
    const dir = mkdtempSync(join(tmpdir(), 'waiver-'));
    roots.push(dir);
    const path = join(dir, 'release', 'waivers.jsonl');
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const r = req({ reason: `tracked in the vendor ticket ${token}` });
    const d = evaluateWaiver(m, r, local);
    if (!d.ok) throw new Error('expected ok');
    const res = recordWaiver(r, d, NOW, path);
    expect(waiverResponseSchema.safeParse(res).success).toBe(true);
    expect(res).toMatchObject({ accepted: true, status: 'queued', expiresAt: '2026-11-30T12:00:00.000Z', maxDays: 30 });
    const line = readFileSync(path, 'utf8').trim();
    expect(line).not.toContain(token);
    expect(JSON.parse(line)).toMatchObject({ actor: 'local-operator', reviewerKind: 'operator', fingerprint: 'a'.repeat(64), stages: ['stable'], expiresAt: '2026-11-30T12:00:00.000Z' });
  });
});
