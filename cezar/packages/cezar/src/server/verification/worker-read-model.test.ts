import { describe, expect, it } from 'vitest';
import { explainScheduling, projectWorkers, redactError, type WorkerRecord } from './worker-read-model.ts';
import { parseWorkerCapabilities } from './worker-capabilities.ts';

const now = Date.parse('2026-01-01T00:10:00Z');
const caps = parseWorkerCapabilities({ os: 'linux', gpu: true });
const rec = (id: string, over: Partial<WorkerRecord> = {}): WorkerRecord => ({ id, capabilities: caps, lastHeartbeatAt: '2026-01-01T00:09:55Z', maxConcurrency: 2, ...over });

describe('worker read model (#219)', () => {
  it('never reports stale, offline or never-seen workers as healthy', () => {
    const page = projectWorkers([
      rec('a'),
      rec('b', { lastHeartbeatAt: '2026-01-01T00:09:00Z' }),
      rec('c', { lastHeartbeatAt: '2026-01-01T00:00:00Z' }),
      rec('d', { lastHeartbeatAt: undefined }),
      rec('e', { lastHeartbeatAt: 'garbage' }),
    ], [], { now });
    expect(page.workers.map((w) => w.status)).toEqual(['healthy', 'stale', 'offline', 'unknown', 'unknown']);
  });

  it('applies operator holds only to live workers; revoked always wins', () => {
    const page = projectWorkers([
      rec('a', { operatorState: 'draining' }),
      rec('b', { operatorState: 'quarantined' }),
      rec('c', { operatorState: 'revoked', lastHeartbeatAt: undefined }),
      rec('d', { operatorState: 'draining', lastHeartbeatAt: '2026-01-01T00:00:00Z' }),
    ], [], { now });
    expect(page.workers.map((w) => w.status)).toEqual(['draining', 'quarantined', 'revoked', 'offline']);
  });

  it('canceled and released attempts hold no capacity', () => {
    const attempts = ['running', 'canceled', 'released', 'queued'].map((state, i) => ({ attemptId: `t${i}`, runId: 'r', workerId: 'a', state: state as 'running' }));
    const [w] = projectWorkers([rec('a')], attempts, { now }).workers;
    expect(w!.activeAttempts).toEqual(['t0']);
    expect(w!.queuedAttempts).toEqual(['t3']);
    expect(w!.capacity).toEqual({ max: 2, reserved: 1, available: 1 });
  });

  it('paginates with a stable cursor and caps the page size', () => {
    const ws = ['c', 'a', 'b'].map((id) => rec(id));
    const p1 = projectWorkers(ws, [], { now, limit: 2 });
    expect(p1.workers.map((w) => w.id)).toEqual(['a', 'b']);
    const p2 = projectWorkers(ws, [], { now, limit: 2, cursor: p1.nextCursor! });
    expect(p2.workers.map((w) => w.id)).toEqual(['c']);
    expect(p2.nextCursor).toBeNull();
    expect(projectWorkers(ws, [], { now, limit: 10_000 }).workers).toHaveLength(3);
  });

  it('redacts secrets, credentials and host paths from errors', () => {
    const out = redactError('fetch https://user:pw@host/x failed token=abc123 at /home/bob/work/x and C:\\Users\\bob\\x ghp_abcdefghijkl');
    expect(out).not.toMatch(/pw@|abc123|bob|ghp_/);
    expect(redactError('x'.repeat(1000))!.length).toBeLessThanOrEqual(201);
    expect(redactError(undefined)).toBeNull();
  });

  it('explains why a job cannot be scheduled without mutating anything', () => {
    const page = projectWorkers([rec('a', { lastHeartbeatAt: '2026-01-01T00:00:00Z' }), rec('b')], [], { now });
    const ex = explainScheduling({ os: 'windows', gpu: true }, page.workers);
    expect(ex.schedulable).toBe(false);
    expect(ex.workers.find((w) => w.workerId === 'a')!.reasons).toContain('status:offline');
    expect(ex.workers.find((w) => w.workerId === 'b')!.reasons).toContain('missing:os:windows');
    expect(explainScheduling({ gpu: true }, page.workers).summary).toBe('Runnable on b');
    expect(explainScheduling({}, []).summary).toBe('No workers enrolled');
  });
});
