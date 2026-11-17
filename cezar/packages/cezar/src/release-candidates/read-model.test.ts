import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { releaseCandidatesResponseSchema } from '@open-mercato/cezar-contract';
import { buildReleaseCandidates, readSnapshot, snapshotPath } from './read-model.ts';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const NOW = new Date('2026-11-16T12:00:00Z');
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const sha = (c: string) => c.repeat(40);

function candidate(id: string, over: Record<string, unknown> = {}) {
  return {
    id, state: 'validating', revision: 1, devSha: sha('a'), baseStableSha: sha('b'), candidateSha: sha('c'), configHash: `sha256:${'d'.repeat(64)}`,
    createdAt: '2026-11-16T08:00:00Z', updatedAt: '2026-11-16T11:00:00Z', lease: { owner: 'worker-1', expiresAt: '2026-11-16T13:00:00Z', stale: false },
    tests: { status: 'running', shards: { total: 4, passed: 2, failed: 0 }, assetVersion: 'v7' }, devDrift: { commitsAhead: 3, newestDevSha: sha('e') },
    blockers: [], repairObligations: [], receipts: [], pending: { count: 0, coalescedReason: null, triggers: [] }, nextScheduledAttempt: null,
    links: { pullRequests: [12], issues: [34] }, warnings: [], checkMatrix: [],
    ...over,
  };
}
const snapshot = (projects: Record<string, unknown[]>) => ({ snapshotAt: '2026-11-16T11:59:00Z', projects: Object.fromEntries(Object.entries(projects).map(([k, v]) => [k, { candidates: v }])) });

describe('release candidate read model', () => {
  it('reports unavailable, not an error, when no snapshot exists', () => {
    for (const s of [undefined, null, {}, 'junk']) expect(buildReleaseCandidates(s, NOW)).toMatchObject({ available: false, projects: [] });
    const dir = mkdtempSync(join(tmpdir(), 'rc-'));
    roots.push(dir);
    expect(readSnapshot(join(dir, 'missing.json'))).toBeUndefined();
    expect(snapshotPath({ CEZ_HOME: dir })).toBe(join(dir, 'release', 'candidates.json'));
  });

  it('represents one active candidate per project with history and passes the contract', () => {
    const r = buildReleaseCandidates(snapshot({
      tableflux: [candidate('c2'), candidate('c1', { state: 'promoted', updatedAt: '2026-11-10T00:00:00Z', lease: { owner: null, expiresAt: null, stale: false } })],
      'cezar-factory': [],
    }), NOW);
    expect(releaseCandidatesResponseSchema.safeParse(r).success).toBe(true);
    const flux = r.projects.find((p) => p.projectId === 'tableflux')!;
    expect(flux.active?.id).toBe('c2');
    expect(flux.history.map((c) => c.id)).toEqual(['c1']);
    expect(flux.warnings).toEqual([]);
    expect(r.projects.find((p) => p.projectId === 'cezar-factory')).toMatchObject({ active: null, history: [] });
    expect(r.projects.map((p) => p.projectId)).toEqual(['cezar-factory', 'tableflux']); // deterministic order
    expect(r.snapshotAt).toBe('2026-11-16T11:59:00.000Z');
  });

  it('never hides an integrity violation: more than one nonterminal candidate is flagged', () => {
    const r = buildReleaseCandidates(snapshot({ p: [candidate('a', { updatedAt: '2026-11-16T09:00:00Z' }), candidate('b', { updatedAt: '2026-11-16T10:00:00Z' })] }), NOW);
    const p = r.projects[0]!;
    expect(p.active?.id).toBe('b');
    expect(p.warnings[0]).toMatch(/integrity: 2 nonterminal/);
    expect(p.active?.warnings.some((w) => w.kind === 'integrity')).toBe(true);
    expect(p.history.map((c) => c.id)).toEqual(['a']);
  });

  it('derives a stale lease from the clock for nonterminal candidates only', () => {
    const r = buildReleaseCandidates(snapshot({
      p: [candidate('live', { lease: { owner: 'w', expiresAt: '2026-11-16T11:00:00Z', stale: false } })],
      q: [candidate('done', { state: 'failed', lease: { owner: null, expiresAt: '2026-11-01T00:00:00Z', stale: false } })],
    }), NOW);
    const p = r.projects.find((x) => x.projectId === 'p')!.active!;
    expect(p.lease.stale).toBe(true);
    expect(p.warnings.map((w) => w.kind)).toContain('stale-lease');
    expect(r.projects.find((x) => x.projectId === 'q')!.history[0]!.lease.stale).toBe(false);
  });

  it('redacts tokens and known secrets in every string, by construction', () => {
    const planted = 'fixture-planted-value-0123456789';
    const r = buildReleaseCandidates(snapshot({ p: [candidate('c1', {
      blockers: [{ code: 'scan', message: `leaked ${SECRET} and ${planted}` }],
      pending: { count: 1, coalescedReason: `trigger from ${SECRET}`, triggers: ['schedule'] },
      warnings: [{ kind: 'adapter', message: `adapter said ${planted}` }],
    })] }), NOW, [planted]);
    const text = JSON.stringify(r);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(planted);
    expect(text).toContain('[REDACTED]');
  });

  it('drops a malformed candidate with a warning and ignores unknown fields instead of failing the view', () => {
    const r = buildReleaseCandidates(snapshot({ p: [candidate('good', { futureField: 'x', rawConfig: { token: SECRET } }), { id: 'bad', state: 'nope' }] }), NOW);
    const p = r.projects[0]!;
    expect(p.active?.id).toBe('good');
    expect(JSON.stringify(r)).not.toContain('futureField');
    expect(JSON.stringify(r)).not.toContain(SECRET); // raw config never reaches the model
    expect(p.warnings).toEqual(['a candidate record failed validation and was skipped (bad)']);
  });

  it('serves the check matrix without raw evidence', () => {
    const row = { category: 'sca', status: 'fail', blocking: true, newFindings: 1, knownFindings: 39, provider: { name: 'trivy', version: '0.60.0' }, feed: 'fresh', scope: 'full-repo', sbomDigest: `sha256:${'f'.repeat(64)}`, activeWaivers: 0 };
    const r = buildReleaseCandidates(snapshot({ p: [candidate('c', { checkMatrix: [row] })] }), NOW);
    expect(r.projects[0]!.active!.checkMatrix[0]).toEqual(row);
    const dir = mkdtempSync(join(tmpdir(), 'rc-'));
    roots.push(dir);
    mkdirSync(join(dir, 'release'));
    writeFileSync(snapshotPath({ CEZ_HOME: dir }), JSON.stringify(snapshot({ p: [candidate('c')] })));
    expect(buildReleaseCandidates(readSnapshot(snapshotPath({ CEZ_HOME: dir })), NOW).available).toBe(true);
  });
});
