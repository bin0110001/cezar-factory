import { describe, expect, it, vi } from 'vitest';
import { OperatorActionGuard, projectScenario, type OperatorRequest, type RolePartition } from './scenario-operations.ts';

const part = (over: Partial<RolePartition>): RolePartition => ({ runId: 'r1', scenarioId: 's1', shard: '0', role: 'host', state: 'finished', outcome: 'pass', ...over });

describe('scenario operations projection (#219)', () => {
  it('is incomplete when a role is missing or evidence is missing', () => {
    const v = projectScenario('r1', 's1', ['host', 'client'], [part({ requiredEvidence: ['shot'], evidenceIds: [] })]);
    expect(v.coverage).toEqual({ expectedRoles: ['host', 'client'], missingRoles: ['host', 'client'], complete: false });
    expect(v.missingEvidenceCount).toBe(1);
    expect(v.outcome).toBe('pending');
  });

  it('passes only with all roles finished and evidence present', () => {
    const v = projectScenario('r1', 's1', ['host', 'client'], [
      part({ evidenceIds: ['a'], requiredEvidence: ['a'] }),
      part({ role: 'client' }),
    ]);
    expect(v.outcome).toBe('pass');
  });

  it('distinguishes infra from assertion failure; verdictless finish is infra', () => {
    const infra = projectScenario('r1', 's1', ['host'], [part({ outcome: undefined })]);
    expect(infra.outcome).toBe('infra-failure');
    const both = projectScenario('r1', 's1', ['host', 'client'], [part({ outcome: 'infra-failure' }), part({ role: 'client', outcome: 'assertion-failure' })]);
    expect(both.outcome).toBe('assertion-failure');
    expect([both.infraFailures, both.assertionFailures]).toEqual([1, 1]);
  });

  it('explains queued partitions, shows canceled consistently and redacts errors', () => {
    const v = projectScenario('r1', 's1', ['host', 'client'], [
      part({ state: 'queued', outcome: undefined }),
      part({ role: 'client', state: 'canceled', outcome: undefined, error: 'token=abc123 at /home/u/x/y' }),
    ], { '0:host': 'status:stale' });
    expect(v.partitions.find((p) => p.role === 'host')?.queuedBecause).toBe('status:stale');
    const c = v.partitions.find((p) => p.role === 'client')!;
    expect(c.outcome).toBe('canceled');
    expect(c.error).not.toContain('abc123');
    expect(c.error).not.toContain('/home/u');
    expect(v.outcome).toBe('canceled');
  });
});

describe('operator action guard (#219)', () => {
  const base: OperatorRequest = { idempotencyKey: 'k1', actor: 'ann', permissions: ['worker:admin'], action: 'drain', target: 'w1' };

  it('denies without permission, audits, and does not apply', () => {
    const apply = vi.fn();
    const g = new OperatorActionGuard(apply);
    const r = g.execute({ ...base, permissions: ['worker:read'] });
    expect(r.ok).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(g.audit[0]).toMatchObject({ result: 'denied', actor: 'ann' });
  });

  it('applies once per idempotency key and replays safely', () => {
    const apply = vi.fn();
    const g = new OperatorActionGuard(apply);
    expect(g.execute(base)).toMatchObject({ ok: true, replayed: false });
    expect(g.execute(base)).toMatchObject({ ok: true, replayed: true });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(g.audit.map((a) => a.result)).toEqual(['applied', 'replayed']);
  });

  it('rejects key reuse for a different request and malformed requests', () => {
    const apply = vi.fn();
    const g = new OperatorActionGuard(apply);
    g.execute(base);
    expect(g.execute({ ...base, target: 'w2' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(g.execute({ ...base, idempotencyKey: '' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('only retries infra failures or canceled partitions', () => {
    const apply = vi.fn();
    const g = new OperatorActionGuard(apply);
    const retry = (k: string, targetOutcome: OperatorRequest['targetOutcome']) =>
      g.execute({ idempotencyKey: k, actor: 'ann', permissions: ['run:retry'], action: 'retry', target: 'p', targetOutcome });
    expect(retry('a', 'assertion-failure')).toMatchObject({ ok: false, code: 'ineligible' });
    expect(retry('b', undefined)).toMatchObject({ ok: false, code: 'ineligible' });
    expect(retry('c', 'infra-failure').ok).toBe(true);
    expect(retry('d', 'canceled').ok).toBe(true);
    expect(apply).toHaveBeenCalledTimes(2);
  });
});
