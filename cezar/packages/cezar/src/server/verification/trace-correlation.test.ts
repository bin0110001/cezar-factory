import { describe, expect, it } from 'vitest';
import { buildRunVerificationView, RUN_VIEW_VERSION } from './run-verification-view.ts';
import { projectWorkers, WORKER_READ_MODEL_VERSION } from './worker-read-model.ts';
import type { RolePartition } from './scenario-operations.ts';

const T1 = 'a'.repeat(32);
const part = (over: Partial<RolePartition> = {}): RolePartition => ({
  runId: 'r1', scenarioId: 's1', shard: '0', role: 'host', state: 'finished', outcome: 'pass',
  workerId: 'w1', attemptId: 'at1', traceId: T1, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:10Z', ...over,
});
const base = { runId: 'r1', scenarioId: 's1', expectedRoles: ['host'] };
const ev = { id: 'e1', kind: 'run.started', timestamp: '2026-01-01T00:00:01Z', runId: 'r1', attemptId: 'at1', workerId: 'w1' };
const cfg = { baseUrl: 'https://lf.example.com', projectId: 'p1' };

describe('trace correlation (#219 slice 4)', () => {
  it('joins ledger events and trace links by stable ids, marked diagnostic', () => {
    const v = buildRunVerificationView({ ...base, partitions: [part()], ledgerEvents: [ev], traceBackend: cfg });
    expect(v.schemaVersion).toBe(RUN_VIEW_VERSION);
    expect(RUN_VIEW_VERSION).toBe(3);
    expect(v.correlation.authoritative).toBe(false);
    expect(v.correlation.label).toContain('diagnostic');
    const e = v.correlation.entries[0]!;
    expect(e.ledgerEvents).toEqual([{ id: 'e1', kind: 'run.started', timestamp: '2026-01-01T00:00:01Z' }]);
    expect(e.trace).toEqual({ traceId: T1, url: `https://lf.example.com/project/p1/traces/${T1}` });
  });

  it('does not attach events from other runs or mismatched ids', () => {
    const v = buildRunVerificationView({
      ...base, partitions: [part()],
      ledgerEvents: [{ ...ev, runId: 'r2' }, { ...ev, id: 'e3', attemptId: 'other' }, { ...ev, id: 'e4', workerId: 'w9' }],
    });
    expect(v.correlation.entries[0]!.ledgerEvents).toEqual([]);
  });

  it.each([
    ['missing', undefined, 'not configured'],
    ['unreachable', { ...cfg, reachable: false }, 'unreachable'],
  ])('degrades when backend is %s without changing the verification result', (_n, backend, why) => {
    const none = buildRunVerificationView({ ...base, partitions: [part({ traceId: undefined })] });
    const v = buildRunVerificationView({ ...base, partitions: [part()], traceBackend: backend });
    expect(v.correlation.status).toBe('unavailable');
    expect(v.correlation.unavailableReason).toContain(why);
    expect(v.correlation.entries[0]!.trace).toBeNull();
    expect(v.scenario.outcome).toBe(none.scenario.outcome);
    expect(v.failureClass).toBe(none.failureClass);
    expect(v.warnings).toEqual(none.warnings);
  });

  it('malformed trace id or bad link config never throws and omits links', () => {
    const bad = buildRunVerificationView({ ...base, partitions: [part({ traceId: 'not-hex' })], traceBackend: cfg });
    expect(bad.correlation.status).toBe('unavailable');
    expect(bad.correlation.entries[0]!.trace).toBeNull();
    const badCfg = buildRunVerificationView({ ...base, partitions: [part()], traceBackend: { baseUrl: 'ftp://x', projectId: 'p' } });
    expect(badCfg.correlation.status).toBe('unavailable');
    expect(badCfg.scenario.outcome).toBe('pass');
  });

  it('carries only allowlisted ids: no payloads, paths or secrets', () => {
    const dirty = { ...ev, payload: 'token=abc', prompt: 'do it', kind: 'x /home/u/secret/file token=abc' } as never;
    const v = buildRunVerificationView({ ...base, partitions: [part({ error: 'boom /home/u/x' })], ledgerEvents: [dirty], traceBackend: cfg });
    const json = JSON.stringify(v.correlation);
    expect(json).not.toMatch(/payload|prompt|\/home|token=abc|boom/);
  });

  it('no ledger/trace input yields an empty correlation block', () => {
    const v = buildRunVerificationView({ ...base, partitions: [part({ traceId: undefined })] });
    expect(v.correlation.status).toBe('ok');
    expect(v.correlation.entries[0]!.ledgerEvents).toEqual([]);
    expect(v.correlation.entries[0]!.trace).toBeNull();
  });

  it('worker view exposes correlated ids; trace presence never makes a stale worker healthy', () => {
    const now = Date.parse('2026-01-01T01:00:00Z');
    const page = projectWorkers(
      [{ id: 'w1', capabilities: {} as never, lastHeartbeatAt: '2026-01-01T00:00:00Z' }],
      [{ attemptId: 'at1', runId: 'r1', workerId: 'w1', state: 'running', traceId: T1 }, { attemptId: 'at2', runId: 'r1', workerId: 'w1', state: 'queued', traceId: 'bad' }],
      { now },
    );
    expect(page.schemaVersion).toBe(WORKER_READ_MODEL_VERSION);
    expect(WORKER_READ_MODEL_VERSION).toBe(2);
    const w = page.workers[0]!;
    expect(w.status).toBe('offline');
    expect(w.correlation).toMatchObject({ authoritative: false, attemptIds: ['at1', 'at2'], runIds: ['r1'], traceIds: [T1] });
  });
});
