import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { releaseHistoryResponseSchema, releaseMetricsResponseSchema } from '@open-mercato/cezar-contract';
import { buildHistory, computeMetrics } from './history-metrics.ts';
import { buildReleaseCandidates } from './read-model.ts';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const NOW = new Date('2026-11-16T12:00:00Z');
const sha = (c: string) => c.repeat(40);
const candidate = (id: string, over: Record<string, unknown> = {}) => ({
  id, state: 'validating', revision: 1, devSha: sha('a'), baseStableSha: sha('b'), candidateSha: null, configHash: `sha256:${'d'.repeat(64)}`,
  createdAt: '2026-11-16T08:00:00Z', updatedAt: '2026-11-16T11:00:00Z', lease: { owner: 'w', expiresAt: '2099-01-01T00:00:00Z', stale: false },
  tests: { status: 'running', shards: { total: 1, passed: 0, failed: 0 }, assetVersion: null }, devDrift: { commitsAhead: 0, newestDevSha: null },
  blockers: [], repairObligations: [], receipts: [], pending: { count: 0, coalescedReason: null, triggers: [] }, nextScheduledAttempt: null,
  links: { pullRequests: [], issues: [] }, warnings: [], checkMatrix: [], ...over,
});
const model = (project: Record<string, unknown>) => buildReleaseCandidates({ snapshotAt: '2026-11-16T11:59:00Z', projects: { p: project } }, NOW);

describe('metrics from read-model data', () => {
  it('computes queue wait, suite cost, regressions, forward-port lag, stable age, scheduled checks and AI audit cost', () => {
    const m = computeMetrics(model({
      candidates: [
        candidate('c3', { timing: { queuedAt: '2026-11-16T07:00:00Z', admittedAt: '2026-11-16T07:30:00Z', readyAt: null, terminalAt: null }, cost: { computeSeconds: 7200 }, revision: 2,
          repairObligations: [{ id: 'fp1', state: 'conflict', blocksStable: true, openedAt: '2026-11-15T12:00:00Z' }, { id: 'fp2', state: 'applied', blocksStable: true, openedAt: '2026-11-10T00:00:00Z' }] }),
        candidate('c2', { state: 'promoted', timing: { queuedAt: '2026-11-10T00:00:00Z', admittedAt: '2026-11-10T01:30:00Z', readyAt: null, terminalAt: '2026-11-10T06:00:00Z' }, cost: { computeSeconds: 3600 },
          receipts: [{ id: 'r1', kind: 'promotion', at: '2026-11-10T06:00:00Z', ok: true }], lease: { owner: null, expiresAt: null, stale: false } }),
      ],
      scheduledChecks: [{ checkId: 'dependency-scan', ranAt: '2026-11-16T03:00:00Z', status: 'fail' }, { checkId: 'license-audit', ranAt: '2026-11-15T03:00:00Z', status: 'pass' }],
      aiAudit: [{ at: '2026-11-14T00:00:00Z', outcome: 'ran', reason: 'sensitive-paths', costUsd: 1.25, tokens: 9000 }, { at: '2026-11-15T00:00:00Z', outcome: 'skipped', reason: 'valid-receipt', costUsd: 0, tokens: 0 }],
    }), NOW);
    expect(releaseMetricsResponseSchema.safeParse(m).success).toBe(true);
    const p = m.projects[0]!;
    expect(p.queueWaitMinutes).toEqual({ mean: 60, max: 90, samples: 2 });
    expect(p.suiteCostHours).toEqual({ total: 3, mean: 1.5, samples: 2 });
    expect(p.regressions).toEqual({ candidatesWithRepair: 1, candidates: 2 });
    expect(p.forwardPortLagHours).toEqual({ oldest: 24, unresolved: 1 });
    expect(p.stableAgeHours).toBe(150);
    expect(p.scheduledChecks).toEqual({ runs: 2, failing: 1, lastRanAt: '2026-11-16T03:00:00Z' });
    expect(p.aiAudit).toEqual({ ran: 1, skipped: 1, costUsd: 1.25, tokens: 9000 });
  });

  it('reports null with zero samples when nothing was recorded, never an estimate', () => {
    const p = computeMetrics(model({ candidates: [candidate('c1')] }), NOW).projects[0]!;
    expect(p.queueWaitMinutes).toEqual({ mean: null, max: null, samples: 0 });
    expect(p.suiteCostHours).toEqual({ total: null, mean: null, samples: 0 });
    expect(p.forwardPortLagHours).toEqual({ oldest: null, unresolved: 0 });
    expect(p.stableAgeHours).toBeNull();
    expect(p.aiAudit).toEqual({ ran: 0, skipped: 0, costUsd: 0, tokens: 0 });
    expect(computeMetrics(buildReleaseCandidates(undefined, NOW), NOW)).toMatchObject({ available: false, projects: [] });
  });

  it('ignores a malformed scheduled-check or AI record instead of failing the model', () => {
    const p = computeMetrics(model({ candidates: [], scheduledChecks: [{ checkId: 'x', ranAt: 'not a date', status: 'pass' }, { checkId: 'y', ranAt: '2026-11-16T00:00:00Z', status: 'pass' }], aiAudit: [{ nope: true }] }), NOW).projects[0]!;
    expect(p.scheduledChecks.runs).toBe(1);
    expect(p.aiAudit.ran).toBe(0);
  });
});

describe('history and audit browsing', () => {
  function files() {
    const dir = mkdtempSync(join(tmpdir(), 'history-'));
    roots.push(dir);
    mkdirSync(join(dir, 'release'), { recursive: true });
    return { actions: join(dir, 'release', 'actions.jsonl'), policyAudit: join(dir, 'release', 'audit.jsonl'), policy: join(dir, 'release', 'policy.json') };
  }
  const h = (n: number) => `sha256:${String(n).repeat(64)}`;

  it('merges operator actions and policy changes newest first, with hashes and candidates', () => {
    const f = files();
    appendFileSync(f.actions, JSON.stringify({ id: 'act-1', at: '2026-11-16T09:00:00Z', actor: 'local-operator', action: 'cancel', projectId: 'p', candidateId: 'c1', reason: 'stuck' }) + '\n');
    appendFileSync(f.policyAudit, JSON.stringify({ id: 'pol-1', at: '2026-11-16T10:00:00Z', actor: 'local-operator', projectId: 'p', beforeHash: h(1), afterHash: h(2), reason: 'weekly' }) + '\n');
    const out = buildHistory(model({ candidates: [candidate('c1', { state: 'canceled' })] }), NOW, f);
    expect(releaseHistoryResponseSchema.safeParse(out).success).toBe(true);
    expect(out.entries.map((e) => [e.kind, e.id])).toEqual([['policy-change', 'pol-1'], ['operator-action', 'act-1']]);
    expect(out.entries[0]).toMatchObject({ beforeHash: h(1), afterHash: h(2), summary: 'policy changed: weekly' });
    expect(out.entries[1]).toMatchObject({ candidateId: 'c1', summary: 'cancel c1: stuck' });
    expect(out.candidates).toHaveLength(1);
  });

  it('respects each project retention window and the 30-day default', () => {
    const f = files();
    appendFileSync(f.actions, [
      { id: 'old', at: '2026-10-01T00:00:00Z', actor: 'a', action: 'pause', projectId: 'p', candidateId: 'c1', reason: 'old action' },
      { id: 'recent', at: '2026-11-10T00:00:00Z', actor: 'a', action: 'pause', projectId: 'p', candidateId: 'c1', reason: 'recent action' },
      { id: 'other-old', at: '2026-10-01T00:00:00Z', actor: 'a', action: 'pause', projectId: 'q', candidateId: 'c9', reason: 'q old' },
    ].map((e) => JSON.stringify(e) + '\n').join(''));
    const short = buildHistory(model({ candidates: [] }), NOW, f);
    expect(short.entries.map((e) => e.id)).toEqual(['recent']);   // both projects default to 30 days
    expect(short.retentionDays).toMatchObject({ p: 30, q: 30 });
    writeFileSync(f.policy, JSON.stringify({ schemaVersion: 'release-pipeline/v1', projects: { p: { artifactRetentionDays: 90 } } }));
    const long = buildHistory(model({ candidates: [] }), NOW, f);
    expect(long.entries.map((e) => e.id).sort()).toEqual(['old', 'recent']);   // p keeps 90 days, q still 30
    expect(long.retentionDays).toMatchObject({ p: 90, q: 30 });
  });

  it('drops terminal candidates past retention, keeps active ones, redacts secrets and tolerates junk lines', () => {
    const f = files();
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    appendFileSync(f.actions, 'not json\n' + JSON.stringify({ id: 'a', at: '2026-11-16T09:00:00Z', actor: 'a', action: 'pause', projectId: 'p', candidateId: 'c1', reason: `see ${token}` }) + '\n' + JSON.stringify({ id: 'b', at: 'nonsense', projectId: 'p' }) + '\n');
    const out = buildHistory(model({ candidates: [candidate('live'), candidate('ancient', { state: 'failed', updatedAt: '2026-01-01T00:00:00Z', lease: { owner: null, expiresAt: null, stale: false } })] }), NOW, f);
    expect(out.candidates.map((c) => c.id)).toEqual(['live']);
    expect(out.entries).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain(token);
  });
});
