import { describe, expect, it } from 'vitest';
import {
  TakeoverGuard, authorizeDownload, buildCheckpointTimeline, describePreview, listArtifacts,
  projectGraphicalSessions, PREVIEW_LIMITS, type BrowsableArtifact, type GraphicalSessionRecord,
} from './graphical-session-view.ts';
import { buildRunVerificationView } from './run-verification-view.ts';

const NOW = Date.parse('2026-01-01T00:01:00Z');
const rec = (o: Partial<GraphicalSessionRecord> = {}): GraphicalSessionRecord => ({
  sessionId: 's1', runId: 'r1', state: 'running', owner: 'alice', role: 'host',
  display: ':99', renderer: 'llvmpipe', browser: 'chromium 120', reservedResources: ['display:99'],
  startedAt: '2026-01-01T00:00:00Z', readyAt: '2026-01-01T00:00:03Z', lastFrameAt: '2026-01-01T00:00:58Z', ...o,
});

describe('graphical session rows', () => {
  it('projects fields and a live stream', () => {
    const r = projectGraphicalSessions([rec()], NOW).rows[0]!;
    expect(r.startupMs).toBe(3000);
    expect(r.stream).toBe('live');
    expect(r.fingerprint.renderer).toBe('llvmpipe');
  });
  it('stale, missing and disconnected frames are never live', () => {
    const rows = projectGraphicalSessions([
      rec({ sessionId: 'a', lastFrameAt: '2026-01-01T00:00:00Z' }),
      rec({ sessionId: 'b', lastFrameAt: undefined }),
      rec({ sessionId: 'c', workerConnected: false }),
    ], NOW).rows;
    expect(rows.map((r) => r.stream)).toEqual(['stale', 'unknown', 'stale']);
  });
  it('redacts host paths and secrets', () => {
    const r = projectGraphicalSessions([rec({ display: '/home/bob/x11/sock token=abc123', browser: 'c:\\Users\\bob\\chrome.exe' })], NOW).rows[0]!;
    expect(JSON.stringify(r)).not.toMatch(/bob|abc123/);
  });
});

describe('preview', () => {
  const row = projectGraphicalSessions([rec()], NOW).rows[0]!;
  it('is view-only and bounded', () => {
    const r = describePreview(row, { authenticated: true, permissions: ['preview:view'] }, { fps: 999, kbps: 1e9 });
    expect(r.ok && r.preview.mode).toBe('view-only');
    expect(r.ok && r.preview.fps).toBe(PREVIEW_LIMITS.maxFps);
    expect(r.ok && r.preview.kbps).toBe(PREVIEW_LIMITS.maxKbps);
  });
  it('requires auth and permission; stale is unavailable', () => {
    expect(describePreview(row, { authenticated: false, permissions: ['preview:view'] })).toEqual({ ok: false, code: 'unauthenticated' });
    expect(describePreview(row, { authenticated: true, permissions: [] })).toEqual({ ok: false, code: 'forbidden' });
    const stale = projectGraphicalSessions([rec({ lastFrameAt: undefined })], NOW).rows[0]!;
    const r = describePreview(stale, { authenticated: true, permissions: ['preview:view'] });
    expect(r.ok && r.preview.available).toBe(false);
  });
});

describe('takeover', () => {
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  const grant = { sessionId: 's1', actor: 'bob', expiresAt: '2026-01-01T01:00:00Z' };
  it('denies and audits without a distinct grant (preview permission is not enough)', () => {
    const g = new TakeoverGuard(undefined, () => t0);
    expect(g.request({ actor: 'bob', sessionId: 's1', permissions: ['preview:view'], grant })).toEqual({ ok: false, code: 'forbidden' });
    expect(g.request({ actor: 'bob', sessionId: 's1', permissions: ['takeover:grant'] }).ok).toBe(false);
    expect(g.audit.map((a) => a.event)).toEqual(['request', 'deny', 'request', 'deny']);
    expect(g.agentInput('s1')).toBe('active');
  });
  it('denies an expired grant and a grant for another session', () => {
    const g = new TakeoverGuard(undefined, () => t0);
    expect(g.request({ actor: 'bob', sessionId: 's1', permissions: ['takeover:grant'], grant: { ...grant, expiresAt: '2025-12-31T00:00:00Z' } })).toEqual({ ok: false, code: 'expired' });
    expect(g.request({ actor: 'bob', sessionId: 's2', permissions: ['takeover:grant'], grant })).toEqual({ ok: false, code: 'forbidden' });
  });
  it('suspends agent input and audits every transition', () => {
    const seen: string[] = [];
    const g = new TakeoverGuard((e) => seen.push(e.event), () => t0);
    expect(g.request({ actor: 'bob', sessionId: 's1', permissions: ['takeover:grant'], grant })).toEqual({ ok: true, agentInput: 'suspended' });
    expect(g.agentInput('s1')).toBe('suspended');
    expect(g.request({ actor: 'eve', sessionId: 's1', permissions: ['takeover:grant'], grant: { ...grant, actor: 'eve' } })).toEqual({ ok: false, code: 'busy' });
    expect(g.release('eve', 's1')).toBe(false);
    expect(g.release('bob', 's1')).toBe(true);
    expect(g.agentInput('s1')).toBe('active');
    expect(seen).toEqual(['request', 'grant', 'suspend', 'request', 'deny', 'release', 'resume']);
  });
  it('expiry resumes agent input', () => {
    let now = t0;
    const g = new TakeoverGuard(undefined, () => now);
    g.request({ actor: 'bob', sessionId: 's1', permissions: ['takeover:grant'], grant });
    now = Date.parse('2026-01-01T02:00:00Z');
    g.expire({ s1: grant.expiresAt });
    expect(g.agentInput('s1')).toBe('active');
    expect(g.audit.at(-2)!.event).toBe('expire');
  });
});

describe('artifact browsing', () => {
  const mk = (i: number, o: Partial<BrowsableArtifact> = {}): BrowsableArtifact => ({
    id: `a${String(i).padStart(2, '0')}`, runId: 'r1', kind: 'screenshot', name: `shot${i}.png`, permission: 'artifact:read',
    createdAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`, ...o,
  });
  const all = [...Array.from({ length: 5 }, (_, i) => mk(i)), mk(5, { permission: 'artifact:admin' }), mk(6, { expiresAt: '2025-01-01T00:00:00Z' }), mk(7, { runId: 'other' }), mk(8, { name: '/srv/secret/path/x.png' })];
  const q = { runId: 'r1', permissions: ['artifact:read'] };
  it('paginates by cursor, scoped and retention-aware', () => {
    const p1 = listArtifacts(all, { ...q, limit: 3 }, NOW);
    expect(p1.ok && p1.page.items.map((i) => i.id)).toEqual(['a00', 'a01', 'a02']);
    const next = p1.ok ? p1.page.nextCursor : null;
    const p2 = listArtifacts(all, { ...q, limit: 3, cursor: next! }, NOW);
    expect(p2.ok && p2.page.items.map((i) => i.id)).toEqual(['a03', 'a04', 'a08']);
    expect(p2.ok && p2.page.nextCursor).toBeNull();
    expect(p2.ok && p2.page.hiddenCount).toBe(1);
    expect(JSON.stringify(p2)).not.toContain('/srv/secret');
  });
  it('rejects over-limit pages and bad cursors', () => {
    expect(listArtifacts(all, { ...q, limit: 51 }, NOW)).toEqual({ ok: false, code: 'invalid-limit' });
    expect(listArtifacts(all, { ...q, limit: 0 }, NOW)).toEqual({ ok: false, code: 'invalid-limit' });
    expect(listArtifacts(all, { ...q, cursor: 'nope' }, NOW)).toEqual({ ok: false, code: 'invalid-cursor' });
  });
  it('scopes downloads', () => {
    const d = (artifactId: string, permissions = ['artifact:read'], runId = 'r1') => authorizeDownload(all, { runId, artifactId, permissions }, NOW);
    expect(d('a00')).toEqual({ ok: true, artifactId: 'a00' });
    expect(d('a05')).toEqual({ ok: false, code: 'forbidden' });
    expect(d('a06')).toEqual({ ok: false, code: 'not-found' });
    expect(d('a07')).toEqual({ ok: false, code: 'not-found' });
    expect(d('a00', [])).toEqual({ ok: false, code: 'forbidden' });
  });
});

describe('checkpoint timeline', () => {
  it('marks missing captures and disconnects', () => {
    const t = buildCheckpointTimeline([
      { node: 'n1', name: 'boot', at: '2026-01-01T00:00:01Z', captured: true },
      { node: 'n2', name: 'boot', captured: false },
      { node: 'n3', name: 'boot', captured: false },
    ], ['n3']);
    expect(t.map((e) => e.status)).toEqual(['captured', 'missing', 'disconnected']);
  });
  it('run view carries checkpoints additively with warnings; single-node empty', () => {
    const base = { runId: 'r1', scenarioId: 's1', expectedRoles: ['host'], partitions: [{ runId: 'r1', scenarioId: 's1', shard: '0', role: 'host', state: 'finished' as const, outcome: 'pass' as const, workerId: 'w1' }] };
    const v1 = buildRunVerificationView(base);
    expect(v1.schemaVersion).toBe(3);
    expect(v1.checkpoints).toEqual([]);
    const v2 = buildRunVerificationView({ ...base, checkpoints: [{ node: 'n2', name: 'boot', captured: false }] });
    expect(v2.warnings.join('|')).toContain('checkpoint missing');
  });
});
