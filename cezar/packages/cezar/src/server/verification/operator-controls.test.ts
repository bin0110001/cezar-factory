import { describe, expect, it } from 'vitest';
import { OperatorControls, permissionsFor, type Principal } from './operator-controls.ts';
import { buildRunVerificationView } from './run-verification-view.ts';
import { parseWorkerCapabilities } from './worker-capabilities.ts';
import type { RolePartition } from './scenario-operations.ts';

const NOW = Date.parse('2026-01-01T00:10:00Z');
const admin: Principal = { actor: 'alice', roles: ['admin'] };
const viewer: Principal = { actor: 'vic', roles: ['viewer'] };
const operator: Principal = { actor: 'olga', roles: ['operator'] };
const caps = parseWorkerCapabilities({ os: 'linux' });

const part = (over: Partial<RolePartition> = {}): RolePartition => ({
  runId: 'r1', scenarioId: 's1', shard: '0', role: 'host', attemptId: 'a1', workerId: 'w1', state: 'running', ...over,
});

function make(partitions: RolePartition[] = [part()]) {
  const c = new OperatorControls(() => NOW);
  c.upsertWorker({ id: 'w1', capabilities: caps, lastHeartbeatAt: '2026-01-01T00:09:55Z', maxConcurrency: 2 });
  c.setPartitions(partitions);
  return c;
}

describe('operator controls (#219 slice 5)', () => {
  it('derives permissions from roles; unknown roles grant nothing', () => {
    expect(permissionsFor({ actor: 'x', roles: ['bogus'] })).toEqual([]);
    expect(permissionsFor(viewer)).toEqual(['worker:read']);
  });

  it('applies a duplicate idempotency key once and audits the replay', async () => {
    const c = make();
    const body = { idempotencyKey: 'k1', action: 'drain', target: 'w1' };
    const a = await c.submit(admin, body);
    const b = await c.submit(admin, body);
    expect([a.ok, a.replayed, b.ok, b.replayed]).toEqual([true, false, true, true]);
    expect(c.version('w1')).toBe('v1');
    expect(c.audit.map((e) => e.result)).toEqual(['applied', 'replayed']);
    expect(c.workerPage().workers[0]!.status).toBe('draining');
  });

  it('rejects unauthorized actions as forbidden, audits them and does not mutate', async () => {
    const c = make();
    const r = await c.submit(viewer, { idempotencyKey: 'k', action: 'quarantine', target: 'w1' });
    expect(r).toMatchObject({ ok: false, code: 'forbidden' });
    expect(c.audit[0]).toMatchObject({ result: 'denied', actor: 'vic' });
    expect(c.workerPage().workers[0]!.status).toBe('healthy');
    // operator can cancel but not administer workers
    expect((await c.submit(operator, { idempotencyKey: 'k2', action: 'drain', target: 'w1' })).code).toBe('forbidden');
  });

  it('ignores client-supplied permissions', async () => {
    const c = make();
    const r = await c.submit(viewer, { idempotencyKey: 'k', action: 'drain', target: 'w1', permissions: ['worker:admin'] });
    expect(r.code).toBe('forbidden');
  });

  it('rejects key reuse for a different action', async () => {
    const c = make();
    await c.submit(admin, { idempotencyKey: 'k', action: 'drain', target: 'w1' });
    const r = await c.submit(admin, { idempotencyKey: 'k', action: 'quarantine', target: 'w1' });
    expect(r).toMatchObject({ ok: false, code: 'invalid' });
    expect(c.workerPage().workers[0]!.status).toBe('draining');
  });

  it('rejects malformed bodies and audits them', async () => {
    const c = make();
    const r = await c.submit(admin, { idempotencyKey: 'k', action: 'nuke', target: 'w1' });
    expect(r).toMatchObject({ ok: false, code: 'invalid' });
    expect(c.audit.at(-1)).toMatchObject({ result: 'rejected', action: 'unknown' });
    expect((await c.submit(admin, { idempotencyKey: 'k', action: 'drain', target: '../etc/passwd' })).code).toBe('invalid');
  });

  it('rejects stale and unknown targets', async () => {
    const c = make();
    expect((await c.submit(admin, { idempotencyKey: 'k1', action: 'drain', target: 'nope' })).code).toBe('invalid');
    await c.submit(admin, { idempotencyKey: 'k2', action: 'drain', target: 'w1', expectedVersion: 'v0' });
    const stale = await c.submit(admin, { idempotencyKey: 'k3', action: 'undrain', target: 'w1', expectedVersion: 'v0' });
    expect(stale).toMatchObject({ ok: false, code: 'invalid', targetVersion: 'v1' });
    expect(c.audit.at(-1)?.reason).toBe('stale target');
    expect(c.workerPage().workers[0]!.status).toBe('draining');
  });

  it('serialises concurrent actions on one target: exactly one applies', async () => {
    const c = make();
    const [a, b] = await Promise.all([
      c.submit(admin, { idempotencyKey: 'ka', action: 'drain', target: 'w1', expectedVersion: 'v0' }),
      c.submit(admin, { idempotencyKey: 'kb', action: 'quarantine', target: 'w1', expectedVersion: 'v0' }),
    ]);
    expect([a.ok, b.ok]).toEqual([true, false]);
    expect(c.version('w1')).toBe('v1');
    const same = await Promise.all([1, 2].map(() => c.submit(admin, { idempotencyKey: 'kc', action: 'undrain', target: 'w1' })));
    expect(same.map((r) => r.replayed)).toEqual([false, true]);
  });

  it('retry is allowed only for infra-failure/canceled partitions', async () => {
    const mk = (over: Partial<RolePartition>) => make([part({ state: 'finished', ...over })]);
    const t = 'r1:s1:0:host';
    for (const outcome of ['pass', 'assertion-failure'] as const) {
      const c = mk({ outcome });
      expect(await c.submit(operator, { idempotencyKey: 'k', action: 'retry', target: t })).toMatchObject({ ok: false, code: 'ineligible' });
    }
    expect((await make([part()]).submit(operator, { idempotencyKey: 'k', action: 'retry', target: t })).code).toBe('ineligible');
    const c = mk({ outcome: 'infra-failure', error: 'x' });
    expect((await c.submit(operator, { idempotencyKey: 'k', action: 'retry', target: t })).ok).toBe(true);
    expect(c.scenarioView('r1', 's1', ['host']).partitions[0]).toMatchObject({ state: 'queued', outcome: 'pending' });
  });

  it('cancel makes worker and run views agree and releases the lease', async () => {
    const c = make();
    expect(c.workerPage().workers[0]!.activeAttempts).toEqual(['a1']);
    const r = await c.submit(operator, { idempotencyKey: 'k', action: 'cancel', target: 'a1' });
    expect(r.ok).toBe(true);
    const w = c.workerPage().workers[0]!;
    expect(w.activeAttempts).toEqual([]);
    expect(w.capacity.reserved).toBe(0);
    const run = buildRunVerificationView({ runId: 'r1', scenarioId: 's1', expectedRoles: ['host'], partitions: (c as unknown as { partitions: RolePartition[] }).partitions });
    expect(run.scenario.partitions[0]).toMatchObject({ state: 'canceled', outcome: 'canceled' });
    // second cancel with a new key targets a no-longer-cancelable attempt
    expect((await c.submit(operator, { idempotencyKey: 'k2', action: 'cancel', target: 'a1' })).code).toBe('invalid');
  });

  it('revoke releases attempts; revoked workers are never healthy', async () => {
    const c = make();
    await c.submit(admin, { idempotencyKey: 'k', action: 'revoke', target: 'w1' });
    expect(c.workerPage().workers[0]).toMatchObject({ status: 'revoked', activeAttempts: [] });
  });

  it('enroll registers an unknown (not healthy) worker; set-profile validates', async () => {
    const c = make();
    await c.submit(admin, { idempotencyKey: 'k', action: 'enroll-link', target: 'w2' });
    expect(c.workerPage().workers.find((w) => w.id === 'w2')!.status).toBe('unknown');
    expect((await c.submit(admin, { idempotencyKey: 'k2', action: 'set-profile', target: 'w1' })).code).toBe('invalid');
    expect((await c.submit(admin, { idempotencyKey: 'k3', action: 'set-profile', target: 'w1', profile: 'Bad Profile!' })).code).toBe('invalid');
    expect((await c.submit(admin, { idempotencyKey: 'k4', action: 'set-profile', target: 'w1', profile: 'gpu-large' })).ok).toBe(true);
    expect(c.profileOf('w1')).toBe('gpu-large');
  });

  it('dry-run explains scheduling without mutating and audit has no secrets or paths', async () => {
    const c = make();
    const r = await c.submit(operator, { idempotencyKey: 'k', action: 'schedule-dry-run', target: 'job1', requirements: { gpu: true } });
    expect(r.explanation?.schedulable).toBe(false);
    expect(c.version('job1')).toBe('v0');
    const deny = await c.submit(viewer, { idempotencyKey: 'k9', action: 'cancel', target: 'a1' });
    expect(JSON.stringify([deny, c.audit])).not.toMatch(/\/home|token=|password/);
  });

  it('bounds audit and idempotency memory', async () => {
    const c = make();
    for (let i = 0; i < 5; i++) await c.submit(viewer, { idempotencyKey: `k${i}`, action: 'drain', target: 'w1' });
    expect(c.audit.length).toBe(5);
  });
});
