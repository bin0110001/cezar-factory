import { describe, expect, it } from 'vitest';
import { DEFAULT_FRESHNESS, WORKER_READ_MODEL_VERSION, deriveWorkerStatus, explainScheduling, projectWorkers, type WorkerRecord } from './worker-read-model.ts';
import { MAX_PARTITION_ROWS, SCENARIO_OPS_VERSION, projectScenario, type RolePartition } from './scenario-operations.ts';
import { MAX_TIMELINE_ROWS, MAX_WARNINGS, RUN_VIEW_VERSION, buildRunVerificationView } from './run-verification-view.ts';
import { parseWorkerCapabilities } from './worker-capabilities.ts';

const now = Date.parse('2026-01-01T00:10:00Z');
const caps = parseWorkerCapabilities({ os: 'linux' });
const rec = (id: string, over: Partial<WorkerRecord> = {}): WorkerRecord => ({ id, capabilities: caps, lastHeartbeatAt: '2026-01-01T00:09:58Z', maxConcurrency: 1, ...over });
const part = (i: number, over: Partial<RolePartition> = {}): RolePartition => ({
  runId: 'r', scenarioId: 's', shard: String(i).padStart(4, '0'), role: 'host', state: 'finished', outcome: 'pass', workerId: 'w1', ...over,
});

describe('distributed views hardening (#219 slice 7)', () => {
  it('pins schema versions', () => {
    expect([WORKER_READ_MODEL_VERSION, SCENARIO_OPS_VERSION, RUN_VIEW_VERSION]).toEqual([1, 1, 2]);
  });

  it('pages workers and returns an empty page for a stale or invalid cursor', () => {
    const ws = Array.from({ length: 5 }, (_, i) => rec(`w${i}`));
    const p1 = projectWorkers(ws, [], { now, limit: 2 });
    expect(p1.workers).toHaveLength(2);
    expect(p1.nextCursor).toBe('w1');
    const p2 = projectWorkers(ws, [], { now, limit: 2, cursor: p1.nextCursor! });
    expect(p2.workers.map((w) => w.id)).toEqual(['w2', 'w3']);
    const stale = projectWorkers(ws, [], { now, limit: 2, cursor: 'zzz' });
    expect(stale.workers).toEqual([]);
    expect(stale.nextCursor).toBeNull();
  });

  it('never labels future, missing, stale or offline heartbeats healthy', () => {
    const f = DEFAULT_FRESHNESS;
    const future = deriveWorkerStatus(rec('a', { lastHeartbeatAt: '2026-01-01T01:00:00Z' }), now, f);
    expect(future.status).toBe('unknown');
    for (const hb of [undefined, 'nope', '2026-01-01T00:09:00Z', '2026-01-01T00:00:00Z']) {
      expect(deriveWorkerStatus(rec('a', { lastHeartbeatAt: hb }), now, f).status).not.toBe('healthy');
    }
  });

  it('bounds and redacts the scheduling summary', () => {
    const views = projectWorkers(
      Array.from({ length: 40 }, (_, i) => rec(`worker-${i}-token=hunter2secret`, { lastHeartbeatAt: undefined })), [], { now, limit: 40 },
    ).workers;
    const ex = explainScheduling({}, views);
    expect(ex.schedulable).toBe(false);
    expect(ex.summary.length).toBeLessThanOrEqual(401);
    expect(ex.summary).not.toContain('hunter2secret');
  });

  it('explains why queued, where partitions run and what evidence is missing', () => {
    const views = projectWorkers([rec('w1', { lastHeartbeatAt: '2026-01-01T00:00:00Z' })], [], { now }).workers;
    const ex = explainScheduling({}, views);
    expect(ex.summary).toContain('status:offline');
    const v = buildRunVerificationView({
      runId: 'r', scenarioId: 's', expectedRoles: ['host', 'client'],
      partitions: [
        part(0, { state: 'queued', outcome: undefined, workerId: undefined }),
        part(1, { role: 'client', state: 'running', outcome: undefined, workerId: 'w1', requiredEvidence: ['shot'] }),
      ],
      queueReasons: { '0000:host': 'no eligible worker' },
      unhealthyWorkers: ['w1'],
    });
    expect(v.scenario.partitions[0]).toMatchObject({ queuedBecause: 'no eligible worker' });
    expect(v.scenario.partitions[1]).toMatchObject({ workerId: 'w1', missingEvidence: ['shot'] });
    expect(v.warnings.join('|')).toMatch(/worker disconnected/);
    expect(v.warnings.join('|')).toMatch(/missing shot/);
  });

  it('caps partitions, timeline and warnings with truncation indicators', () => {
    const n = Math.max(MAX_PARTITION_ROWS, MAX_TIMELINE_ROWS) + 10;
    const parts = Array.from({ length: n }, (_, i) => part(i, { requiredEvidence: ['e'] }));
    const sc = projectScenario('r', 's', ['host'], parts);
    expect(sc.partitions).toHaveLength(MAX_PARTITION_ROWS);
    expect(sc.partitionsTruncated).toBe(true);
    expect(sc.hiddenPartitions).toBe(n - MAX_PARTITION_ROWS);
    expect(sc.missingEvidenceCount).toBe(n);
    const v = buildRunVerificationView({ runId: 'r', scenarioId: 's', expectedRoles: ['host'], partitions: parts });
    expect(v.timeline).toHaveLength(MAX_TIMELINE_ROWS);
    expect(v.warnings).toHaveLength(MAX_WARNINGS);
    expect(v.truncated).toEqual({ timeline: true, checkpoints: false, warnings: true });
  });

  it('redacts secrets and paths in run warnings and partition errors', () => {
    const v = buildRunVerificationView({
      runId: 'r', scenarioId: 's', expectedRoles: ['host'],
      partitions: [part(0, { error: 'password=abc https://u:p@h/x /home/user/y', requiredEvidence: ['e'] })],
    });
    const text = JSON.stringify(v);
    expect(text).not.toContain('/home/user');
    expect(text).not.toContain('u:p@');
    expect(text).not.toContain('password=abc');
  });
});
