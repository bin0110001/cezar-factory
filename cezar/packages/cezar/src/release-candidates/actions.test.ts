import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { candidateActionRequestSchema, candidateActionResponseSchema, type CandidateActionRequest } from '@open-mercato/cezar-contract';
import { evaluateAction, recordAction } from './actions.ts';
import { buildReleaseCandidates } from './read-model.ts';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const NOW = new Date('2026-11-16T12:00:00Z');
const sha = (c: string) => c.repeat(40);
const candidate = (id: string, over: Record<string, unknown> = {}) => ({
  id, state: 'validating', revision: 1, devSha: sha('a'), baseStableSha: sha('b'), candidateSha: sha('c'), configHash: `sha256:${'d'.repeat(64)}`,
  createdAt: '2026-11-16T08:00:00Z', updatedAt: '2026-11-16T11:00:00Z', lease: { owner: 'w', expiresAt: '2099-01-01T00:00:00Z', stale: false },
  tests: { status: 'running', shards: { total: 1, passed: 0, failed: 0 }, assetVersion: null }, devDrift: { commitsAhead: 0, newestDevSha: null },
  blockers: [], repairObligations: [], receipts: [], pending: { count: 0, coalescedReason: null, triggers: [] }, nextScheduledAttempt: null,
  links: { pullRequests: [], issues: [] }, warnings: [], checkMatrix: [], ...over,
});
const snap = (projects: Record<string, unknown[]>) => buildReleaseCandidates({ snapshotAt: '2026-11-16T11:59:00Z', projects: Object.fromEntries(Object.entries(projects).map(([k, v]) => [k, { candidates: v }])) }, NOW);
const req = (over: Partial<CandidateActionRequest> = {}): CandidateActionRequest => ({ action: 'pause', projectId: 'p', candidateId: 'c1', reason: 'operator request', ...over });
const local = { localHandoff: true };

describe('request validation', () => {
  it('requires an action, a project and a reason, and rejects unknown fields', () => {
    expect(candidateActionRequestSchema.safeParse(req()).success).toBe(true);
    for (const bad of [{ action: 'delete' }, { reason: 'x' }, { reason: '' }, { projectId: '' }, { extra: 1 }]) expect(candidateActionRequestSchema.safeParse({ ...req(), ...bad }).success).toBe(false);
  });
});

describe('permissions and snapshot', () => {
  it('denies every action from a remote cockpit', () => {
    for (const action of ['create', 'pause', 'resume', 'cancel', 'abandon', 'retry'] as const) {
      const d = evaluateAction(snap({ p: [candidate('c1')] }), req({ action, confirm: 'c1' }), { localHandoff: false });
      expect(d).toMatchObject({ ok: false, status: 403 });
    }
  });

  it('cannot validate against a missing snapshot or an unknown project', () => {
    expect(evaluateAction(snap({}), req(), local)).toMatchObject({ ok: false, status: 404 });
    expect(evaluateAction(buildReleaseCandidates(undefined, NOW), req(), local)).toMatchObject({ ok: false, status: 409 });
  });
});

describe('the one-active-candidate rule', () => {
  it('rejects creating a second candidate with a clear message, and allows create when none is active', () => {
    const refused = evaluateAction(snap({ p: [candidate('c1', { state: 'awaiting-approval' })] }), req({ action: 'create', candidateId: undefined }), local);
    expect(refused).toMatchObject({ ok: false, status: 409 });
    expect((refused as { error: string }).error).toMatch(/already has an active candidate \(c1, awaiting-approval\).*Only one candidate can be active/);
    const ok = evaluateAction(snap({ p: [candidate('c0', { state: 'promoted' })] }), req({ action: 'create', candidateId: undefined }), local);
    expect(ok).toMatchObject({ ok: true, candidateId: null });
  });
});

describe('targeting and state', () => {
  it('needs the active candidate: another id, none active or a missing id are refused', () => {
    const s = snap({ p: [candidate('c1')] });
    expect(evaluateAction(s, req({ candidateId: 'other' }), local)).toMatchObject({ ok: false, status: 409 });
    expect(evaluateAction(s, req({ candidateId: undefined }), local)).toMatchObject({ ok: false, status: 400 });
    expect(evaluateAction(snap({ p: [candidate('c1', { state: 'failed' })] }), req(), local)).toMatchObject({ ok: false, status: 409 });
    expect(evaluateAction(s, req(), local)).toMatchObject({ ok: true, candidateId: 'c1' });
    expect(evaluateAction(s, req({ action: 'resume' }), local)).toMatchObject({ ok: true });
  });

  it('retry applies to a candidate needing repair, or restarts the last failed one when nothing is active', () => {
    expect(evaluateAction(snap({ p: [candidate('c1')] }), req({ action: 'retry' }), local)).toMatchObject({ ok: false, status: 409 });
    expect(evaluateAction(snap({ p: [candidate('c1', { state: 'repair-required' })] }), req({ action: 'retry' }), local)).toMatchObject({ ok: true });
    expect(evaluateAction(snap({ p: [candidate('c1', { state: 'failed' })] }), req({ action: 'retry', candidateId: undefined }), local)).toMatchObject({ ok: true, candidateId: 'c1' });
    expect(evaluateAction(snap({ p: [candidate('c1', { state: 'promoted' })] }), req({ action: 'retry', candidateId: undefined }), local)).toMatchObject({ ok: false, status: 409 });
  });
});

describe('typed confirmation for destructive actions', () => {
  it('requires the candidate id to be typed for cancel and abandon', () => {
    const s = snap({ p: [candidate('c1')] });
    for (const action of ['cancel', 'abandon'] as const) {
      expect(evaluateAction(s, req({ action }), local)).toMatchObject({ ok: false, status: 400 });
      expect(evaluateAction(s, req({ action, confirm: 'wrong' }), local)).toMatchObject({ ok: false, status: 400 });
      expect((evaluateAction(s, req({ action }), local) as { error: string }).error).toContain('type the candidate id (c1)');
      expect(evaluateAction(s, req({ action, confirm: 'c1' }), local)).toMatchObject({ ok: true, candidateId: 'c1' });
    }
    expect(evaluateAction(s, req({ action: 'pause' }), local)).toMatchObject({ ok: true }); // non-destructive needs none
  });
});

describe('audit', () => {
  it('appends one redacted audit entry per accepted action and returns the queued response', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-actions-'));
    roots.push(dir);
    const path = join(dir, 'release', 'actions.jsonl');
    const s = snap({ p: [candidate('c1')] });
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const r = req({ action: 'cancel', confirm: 'c1', reason: `stuck, token ${token}` });
    const d = evaluateAction(s, r, local);
    if (!d.ok) throw new Error('expected ok');
    const res = recordAction(r, d, s, NOW, path);
    expect(candidateActionResponseSchema.safeParse(res).success).toBe(true);
    expect(res).toMatchObject({ accepted: true, status: 'queued', action: 'cancel', candidateId: 'c1' });
    recordAction(req(), { ok: true, candidateId: 'c1', message: 'm' }, s, NOW, path);
    const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ actor: 'local-operator', action: 'cancel', projectId: 'p', candidateId: 'c1', confirmed: true, snapshotAt: '2026-11-16T11:59:00.000Z' });
    expect(JSON.stringify(lines)).not.toContain(token);
    expect(lines[0]!.id).not.toBe(lines[1]!.id);
  });

  it('a write failure is thrown, so the caller never reports a request that was not recorded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-actions-'));
    roots.push(dir);
    const s = snap({ p: [candidate('c1')] });
    expect(() => recordAction(req(), { ok: true, candidateId: 'c1', message: 'm' }, s, NOW, join(dir, 'nul\u0000bad', 'x.jsonl'))).toThrow();
  });
});
