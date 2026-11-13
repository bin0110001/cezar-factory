import { describe, expect, it } from 'vitest';
import { buildRunVerificationView, type RunHistoryEntry } from './run-verification-view.ts';
import type { RolePartition } from './scenario-operations.ts';

const part = (over: Partial<RolePartition>): RolePartition => ({
  runId: 'r1', scenarioId: 's1', shard: '0', role: 'host', state: 'finished', outcome: 'pass',
  workerId: 'w1', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:10Z', ...over,
});
const hist = (n: number, ms: number): RunHistoryEntry[] =>
  Array.from({ length: n }, (_, i) => ({ runId: `h${i}`, outcome: 'pass', durationMs: ms, finishedAt: `2025-12-0${i + 1}T00:00:00Z` }));

describe('run verification view (#219)', () => {
  it('flags a disconnected worker and missing evidence, never healthy', () => {
    const v = buildRunVerificationView({
      runId: 'r1', scenarioId: 's1', expectedRoles: ['host', 'client'],
      partitions: [part({ state: 'running', outcome: undefined, finishedAt: undefined, requiredEvidence: ['shot'] })],
      unhealthyWorkers: ['w1'],
    });
    expect(v.timeline[0]!.workerDisconnected).toBe(true);
    expect(v.warnings.join('|')).toContain('worker disconnected');
    expect(v.warnings.join('|')).toContain('missing shot');
    expect(v.scenario.outcome).toBe('pending');
  });

  it('classifies failures and keeps traces non-authoritative', () => {
    const v = buildRunVerificationView({
      runId: 'r1', scenarioId: 's1', expectedRoles: ['host', 'client'],
      partitions: [part({ outcome: 'infra-failure', traceId: 't1' }), part({ role: 'client', outcome: 'assertion-failure' })],
    });
    expect(v.failureClass).toBe('both');
    expect(v.traces).toEqual({ authoritative: false, ids: ['t1'] });
  });

  it('baseline needs enough passing samples; flags regression; picks last success', () => {
    const base = { runId: 'r1', scenarioId: 's1', expectedRoles: ['host'], partitions: [part({})] };
    expect(buildRunVerificationView({ ...base, history: hist(2, 1000) }).baseline.regression).toBe('unknown');
    const v = buildRunVerificationView({ ...base, history: [...hist(3, 1000), { runId: 'bad', outcome: 'infra-failure', durationMs: 1, finishedAt: '2026-02-01T00:00:00Z' }] });
    expect(v.baseline.medianMs).toBe(1000);
    expect(v.baseline.regression).toBe(false);
    expect(v.lastSuccessfulRun?.runId).toBe('h2');
    const slow = buildRunVerificationView({ ...base, partitions: [part({ finishedAt: '2026-01-01T00:01:00Z' })], history: hist(3, 1000) });
    expect(slow.baseline.regression).toBe(true);
  });

  it('scopes artifact links by permission and bounds the list', () => {
    const artifacts = Array.from({ length: 60 }, (_, i) => ({ id: `a${i}`, kind: 'screenshot' as const, permission: 'artifact:read' }));
    artifacts.push({ id: 'secret', kind: 'video', permission: 'artifact:admin' });
    const v = buildRunVerificationView({
      runId: 'r1', scenarioId: 's1', expectedRoles: ['host'], partitions: [part({})], artifacts, permissions: ['artifact:read'],
    });
    expect(v.artifacts.visible).toHaveLength(50);
    expect(v.artifacts.truncated).toBe(true);
    expect(v.artifacts.hiddenCount).toBe(1);
    expect(v.artifacts.visible.some((a) => a.id === 'secret')).toBe(false);
  });

  it('topology is unknown without requirements and checks host count', () => {
    const p = [part({}), part({ role: 'client', workerId: 'w2' })];
    const base = { runId: 'r1', scenarioId: 's1', expectedRoles: ['host', 'client'], partitions: p };
    expect(buildRunVerificationView(base).topology.satisfied).toBe('unknown');
    expect(buildRunVerificationView({ ...base, topology: [{ role: 'host', requires: ['gpu'], minHosts: 2 }] }).topology.satisfied).toBe(true);
    expect(buildRunVerificationView({ ...base, topology: [{ role: 'host', requires: ['gpu'], minHosts: 3 }] }).topology.satisfied).toBe(false);
  });
});
