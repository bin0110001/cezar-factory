import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { WorkflowActionService } from './workflow-actions.ts';

const dirs: string[] = [];
function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cezar-actions-')); dirs.push(dataDir);
  const run = { id: 'r1', status: 'waiting', steps: [], workflowExecution: { status: 'waiting', wait: { reason: 'human' } } };
  const store = { getRun: vi.fn(() => run), appendEvent: vi.fn() } as unknown as RunStore;
  const manager = { cancel: vi.fn(() => true), resumeVersionedRun: vi.fn(() => ({ ok: true })), recover: vi.fn(async () => {}) } as unknown as RunManager;
  return { dataDir, store, manager, service: new WorkflowActionService(dataDir, store, manager, () => 1234) };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('durable workflow actions', () => {
  it('persists write-ahead and completion records and replays across service restart', async () => {
    const f = fixture();
    const input = { idempotencyKey: 'key-1', action: 'approve' as const, runId: 'r1', expectedVersion: f.service.snapshot('r1')! };
    const principal = { actor: 'test-user', roles: ['admin' as const] };
    expect((await f.service.submit(principal, input)).ok).toBe(true);
    const restarted = new WorkflowActionService(f.dataDir, f.store, f.manager);
    expect(await restarted.submit(principal, input)).toMatchObject({ ok: true, replayed: true });
    expect(f.manager.resumeVersionedRun).toHaveBeenCalledTimes(1);
    expect(restarted.history('r1').map((entry) => entry.phase)).toEqual(['started', 'completed']);
  });

  it('rejects viewer roles and stale versions without invoking the controller', async () => {
    const f = fixture();
    const current = f.service.snapshot('r1')!;
    expect(await f.service.submit({ actor: 'viewer', roles: ['viewer'] }, { idempotencyKey: 'deny', action: 'approve', runId: 'r1', expectedVersion: current })).toMatchObject({ ok: false, error: 'forbidden', record: { phase: 'denied', actor: 'viewer' } });
    expect(await f.service.submit({ actor: 'admin', roles: ['admin'] }, { idempotencyKey: 'stale', action: 'approve', runId: 'r1', expectedVersion: '0'.repeat(64) })).toMatchObject({ ok: false, error: 'stale run snapshot' });
    expect(f.manager.resumeVersionedRun).not.toHaveBeenCalled();
  });

  it('does not repeat a mutation if the durable journal contains an unfinished intent', async () => {
    const f = fixture();
    const input = { idempotencyKey: 'uncertain', action: 'cancel' as const, runId: 'r1', expectedVersion: f.service.snapshot('r1')! };
    const principal = { actor: 'operator', roles: ['operator' as const] };
    // A started-only record represents a process crash after writing intent.
    const fs = await import('node:fs');
    fs.appendFileSync(join(f.dataDir, 'workflow-actions.ndjson'), `${JSON.stringify({ ...input, actor: principal.actor, phase: 'started', at: new Date(0).toISOString() })}\n`);
    expect(await f.service.submit(principal, input)).toMatchObject({ ok: false, replayed: true });
    expect(f.manager.cancel).not.toHaveBeenCalled();
  });

  it('records failed actions without leaking controller errors and refuses automatic replay', async () => {
    const f = fixture();
    vi.mocked(f.manager.cancel).mockImplementation(() => { throw new Error('failed at C:\\private\\repo with token ghp_abcdef'); });
    const input = { idempotencyKey: 'failure', action: 'cancel' as const, runId: 'r1', expectedVersion: f.service.snapshot('r1')! };
    const principal = { actor: 'operator', roles: ['operator' as const] };
    expect(await f.service.submit(principal, input)).toMatchObject({ ok: false, error: 'action failed; inspect run history', record: { phase: 'failed' } });
    expect(await f.service.submit(principal, input)).toMatchObject({ ok: false, replayed: true });
    const journal = f.service.history('r1');
    expect(journal.map((entry) => entry.phase)).toEqual(['started', 'failed']);
    expect(JSON.stringify(journal)).not.toMatch(/private|ghp_/);
    expect(f.manager.cancel).toHaveBeenCalledTimes(1);
  });
});
