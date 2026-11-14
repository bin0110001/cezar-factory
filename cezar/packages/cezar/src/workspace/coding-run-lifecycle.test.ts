import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodingRunRecord } from '@open-mercato/cezar-contract';
import { appendCodingRunEvent, createCodingRun, getCodingRunSnapshot, rebuildCodingRunProjection } from './lifecycle.ts';
import {
  attemptWorktreePath, auditLifecycleConsistency, decideAfterFailure, DEFAULT_LIFECYCLE_BUDGETS, planResume, stageOfEvent, terminalOutcome,
} from './coding-run-lifecycle.ts';

const roots: string[] = [];
const t0 = Date.parse('2026-11-10T08:00:00.000Z');
const at = (minutes: number) => new Date(t0 + minutes * 60_000).toISOString();

function workspace(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'coding-run-lifecycle-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'dev'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root });
  return { root, home: join(root, 'cez-home') };
}
function record(runId: string): CodingRunRecord {
  return {
    schemaVersion: 1, runId, projectId: 'p', correlationId: `c-${runId}`,
    source: { number: 131, revision: { availability: 'unknown' } }, baseSha: { availability: 'unknown' },
    pullRequest: { availability: 'unknown' }, worker: { availability: 'unknown' }, agent: { availability: 'unknown' },
    model: { availability: 'unknown' }, promptSha256: { availability: 'unknown' }, skillSha256: [], status: 'running', startedAt: at(0),
  };
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

type Ws = ReturnType<typeof workspace>;
const ev = (w: Ws, runId: string, input: Record<string, unknown>) =>
  appendCodingRunEvent({ runId, cwd: w.root, home: w.home, strictLifecycle: true, ...input } as Parameters<typeof appendCodingRunEvent>[0]);
const happyPath = async (w: Ws, runId: string, attemptId: string, base = 1) => {
  await ev(w, runId, { type: 'attempt.started', attemptId, occurredAt: at(base) });
  for (const [i, type] of (['context.prepared', 'implementation.started', 'implementation.completed', 'validation.completed'] as const).entries()) {
    await ev(w, runId, { type, attemptId, occurredAt: at(base + 1 + i) });
  }
  await ev(w, runId, { type: 'attempt.completed', attemptId, occurredAt: at(base + 6) });
};

describe('coding run lifecycle state machine', { timeout: 180_000 }, () => {
  it('maps events onto the seven stages', () => {
    expect(stageOfEvent('context.prepared')).toBe('context');
    expect(stageOfEvent('repair.started')).toBe('repair');
    expect(stageOfEvent('delivery.opened')).toBe('deliver');
    expect(stageOfEvent('learning.recorded')).toBe('learn');
    expect(stageOfEvent('run.failed')).toBeUndefined();
  });

  it('rejects out-of-order stage events and stale attempt results', async () => {
    const w = workspace();
    await createCodingRun({ record: record('r1'), cwd: w.root, home: w.home });
    await ev(w, 'r1', { type: 'attempt.started', attemptId: 'a1', occurredAt: at(1) });
    await expect(ev(w, 'r1', { type: 'validation.completed', attemptId: 'a1' })).rejects.toThrow(/cannot follow attempt.started/);
    await ev(w, 'r1', { type: 'attempt.failed', attemptId: 'a1', reason: 'infra', occurredAt: at(2) });
    await ev(w, 'r1', { type: 'attempt.started', attemptId: 'a2', supersedesAttemptId: 'a1', occurredAt: at(3) });
    // a late result from the superseded attempt must not be accepted
    await expect(ev(w, 'r1', { type: 'context.prepared', attemptId: 'a1' })).rejects.toThrow(/stale|active attempt is a2/);
    await expect(ev(w, 'r1', { type: 'attempt.completed', attemptId: 'a1' })).rejects.toThrow(/active attempt is a2/);
  });

  it('cancellation wins a race with a late completion', async () => {
    const w = workspace();
    await createCodingRun({ record: record('r2'), cwd: w.root, home: w.home });
    await ev(w, 'r2', { type: 'attempt.started', attemptId: 'a1', occurredAt: at(1) });
    await ev(w, 'r2', { type: 'attempt.cancelled', attemptId: 'a1', reason: 'cancelled', occurredAt: at(2) });
    await expect(ev(w, 'r2', { type: 'attempt.completed', attemptId: 'a1' })).rejects.toThrow();
    await ev(w, 'r2', { type: 'run.cancelled', reason: 'cancelled', occurredAt: at(3) });
    const snap = (await getCodingRunSnapshot({ runId: 'r2', cwd: w.root, home: w.home }))!;
    expect(terminalOutcome(snap)).toBe('canceled');
    await expect(ev(w, 'r2', { type: 'attempt.started', attemptId: 'a2' })).rejects.toThrow(/after the run finished|terminal/);
  });

  it('refuses a duplicate delivery even without strict mode, and after a restart', async () => {
    const w = workspace();
    await createCodingRun({ record: record('r3'), cwd: w.root, home: w.home });
    await happyPath(w, 'r3', 'a1');
    await ev(w, 'r3', { type: 'delivery.opened', occurredAt: at(10) });
    // simulated restart: rebuild the projection from the event table, then retry the delivery
    await rebuildCodingRunProjection({ runId: 'r3', cwd: w.root, home: w.home });
    await expect(appendCodingRunEvent({ runId: 'r3', type: 'delivery.opened', cwd: w.root, home: w.home })).rejects.toThrow(/already open/);
    const snap = (await getCodingRunSnapshot({ runId: 'r3', cwd: w.root, home: w.home }))!;
    expect(planResume(snap, new Date(at(11)))).toEqual({ action: 'await-delivery', delivery: 'opened' });
    await ev(w, 'r3', { type: 'delivery.merged', occurredAt: at(12) });
    await expect(ev(w, 'r3', { type: 'delivery.merged' })).rejects.toThrow(/already merged/);
    // a rejected delivery may be opened again
    await ev(w, 'r3', { type: 'delivery.reverted', occurredAt: at(13) });
    await ev(w, 'r3', { type: 'delivery.opened', occurredAt: at(14) });
    expect(auditLifecycleConsistency((await getCodingRunSnapshot({ runId: 'r3', cwd: w.root, home: w.home }))!)).toEqual([]);
  });

  it('keeps distinct outcomes and bounds retries, repairs and waits from the ledger', async () => {
    const w = workspace();
    await createCodingRun({ record: record('r4'), cwd: w.root, home: w.home });
    let snap = (await getCodingRunSnapshot({ runId: 'r4', cwd: w.root, home: w.home }))!;
    expect(decideAfterFailure(snap, 'policy')).toEqual({ action: 'block', reason: 'policy' });
    expect(decideAfterFailure(snap, 'cancelled').action).toBe('cancel');
    expect(decideAfterFailure(snap, 'capacity').action).toBe('wait');
    expect(decideAfterFailure(snap, 'test')).toMatchObject({ action: 'repair', round: 1 });

    // two infra failures consume the infra budget; a third is a bounded failure, not another retry
    let attempt = 0;
    for (let i = 0; i < DEFAULT_LIFECYCLE_BUDGETS.maxInfraRetries; i += 1) {
      attempt += 1;
      await ev(w, 'r4', { type: 'attempt.started', attemptId: `a${attempt}`, ...(attempt > 1 ? { supersedesAttemptId: `a${attempt - 1}` } : {}), occurredAt: at(attempt * 10) });
      await ev(w, 'r4', { type: 'attempt.failed', attemptId: `a${attempt}`, reason: 'infra', occurredAt: at(attempt * 10 + 1) });
      snap = (await getCodingRunSnapshot({ runId: 'r4', cwd: w.root, home: w.home }))!;
      const d = decideAfterFailure(snap, 'infra');
      if (i + 1 < DEFAULT_LIFECYCLE_BUDGETS.maxInfraRetries) expect(d).toMatchObject({ action: 'retry', supersedes: `a${attempt}` });
      else expect(d).toMatchObject({ action: 'fail', exhausted: 'infra-retries' });
    }
    // capacity failures do not consume the infra budget; after the wait budget the run is re-routed
    const waits = decideAfterFailure({ ...snap, events: Array.from({ length: DEFAULT_LIFECYCLE_BUDGETS.maxCapacityWaits }, (_, i) => ({ ...snap.events[0]!, type: 'attempt.failed' as const, reason: 'capacity' as const, eventId: `x${i}`, sequence: i + 1 })) }, 'capacity');
    expect(waits).toEqual({ action: 'reroute', reason: 'capacity' });
    expect(decideAfterFailure(snap, 'capacity').action).toBe('wait');
    await ev(w, 'r4', { type: 'run.failed', reason: 'policy', occurredAt: at(99) });
    expect(terminalOutcome((await getCodingRunSnapshot({ runId: 'r4', cwd: w.root, home: w.home }))!)).toBe('blocked');
  });

  it('bounds repair rounds recorded in the ledger', async () => {
    const w = workspace();
    await createCodingRun({ record: record('r5'), cwd: w.root, home: w.home });
    await ev(w, 'r5', { type: 'attempt.started', attemptId: 'a1', occurredAt: at(1) });
    for (const type of ['context.prepared', 'implementation.started', 'implementation.completed', 'validation.completed'] as const) await ev(w, 'r5', { type, attemptId: 'a1' });
    for (let round = 1; round <= DEFAULT_LIFECYCLE_BUDGETS.maxRepairs; round += 1) {
      const snap = (await getCodingRunSnapshot({ runId: 'r5', cwd: w.root, home: w.home }))!;
      expect(decideAfterFailure(snap, 'test')).toMatchObject({ action: 'repair', round });
      await ev(w, 'r5', { type: 'repair.started', attemptId: 'a1' });
      await ev(w, 'r5', { type: 'repair.completed', attemptId: 'a1' });
      await ev(w, 'r5', { type: 'validation.completed', attemptId: 'a1' });
    }
    const snap = (await getCodingRunSnapshot({ runId: 'r5', cwd: w.root, home: w.home }))!;
    expect(decideAfterFailure(snap, 'parse')).toMatchObject({ action: 'fail', reason: 'budget-exhausted', exhausted: 'repairs' });
  });

  it('plans resume from the ledger: continue, abandon on deadline or lost worker, start fresh', async () => {
    const w = workspace();
    await createCodingRun({ record: record('r6'), cwd: w.root, home: w.home });
    expect(planResume((await getCodingRunSnapshot({ runId: 'r6', cwd: w.root, home: w.home }))!, new Date(at(1)))).toEqual({ action: 'start-attempt' });
    await ev(w, 'r6', { type: 'attempt.started', attemptId: 'a1', occurredAt: at(1) });
    await ev(w, 'r6', { type: 'context.prepared', attemptId: 'a1', occurredAt: at(2) });
    const snap = (await getCodingRunSnapshot({ runId: 'r6', cwd: w.root, home: w.home }))!;
    expect(planResume(snap, new Date(at(3)))).toMatchObject({ action: 'continue', attemptId: 'a1', stage: 'context', next: expect.arrayContaining(['implementation.started']) });
    expect(planResume(snap, new Date(at(3)), { workerAlive: false })).toMatchObject({ action: 'abandon-attempt', why: 'worker-lost' });
    expect(planResume(snap, new Date(at(2 + 16)))).toMatchObject({ action: 'abandon-attempt', why: 'stage-deadline' });
    await ev(w, 'r6', { type: 'attempt.failed', attemptId: 'a1', reason: 'infra', occurredAt: at(20) });
    const after = (await getCodingRunSnapshot({ runId: 'r6', cwd: w.root, home: w.home }))!;
    expect(planResume(after, new Date(at(21)))).toEqual({ action: 'start-attempt', supersedes: 'a1' });
  });

  it('rejects a failure reason on events that cannot fail and stores it on those that can', async () => {
    const w = workspace();
    await createCodingRun({ record: record('r7'), cwd: w.root, home: w.home });
    await ev(w, 'r7', { type: 'attempt.started', attemptId: 'a1' });
    await expect(ev(w, 'r7', { type: 'context.prepared', attemptId: 'a1', reason: 'infra' })).rejects.toThrow(/cannot carry/);
    await ev(w, 'r7', { type: 'attempt.failed', attemptId: 'a1', reason: 'capacity' });
    const snap = (await getCodingRunSnapshot({ runId: 'r7', cwd: w.root, home: w.home }))!;
    expect(snap.events.at(-1)?.reason).toBe('capacity');
  });

  it('gives every attempt its own worktree path', () => {
    const a = attemptWorktreePath('/wt', 'run-1', 'a1');
    expect(a).not.toBe(attemptWorktreePath('/wt', 'run-1', 'a2'));
    expect(attemptWorktreePath('/wt', 'run/../x', '../a')).toBe(join('/wt', 'run_.._x', '.._a'));
  });
});
