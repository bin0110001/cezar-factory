import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';

export type WorkflowActionKind = 'resume' | 'reconcile' | 'cancel' | 'escalate' | 'approve';
export type WorkflowActionRole = 'viewer' | 'operator' | 'admin';
export interface WorkflowActionPrincipal { actor: string; roles: WorkflowActionRole[] }
export interface WorkflowActionInput {
  idempotencyKey: string;
  action: WorkflowActionKind;
  runId: string;
  expectedVersion: string;
  rationale?: string;
}
export interface WorkflowActionRecord extends WorkflowActionInput {
  actor: string;
  phase: 'started' | 'completed' | 'failed' | 'denied' | 'rejected';
  at: string;
  result?: string;
}

const permission: Record<WorkflowActionKind, WorkflowActionRole> = {
  resume: 'operator', reconcile: 'operator', cancel: 'operator', escalate: 'operator', approve: 'admin',
};

/** Durable local-operator action controller. Journal records are write-ahead: after a crash
 * between intent and mutation, replay reports an indeterminate action instead of repeating it. */
export class WorkflowActionService {
  private readonly path: string;
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(private readonly dataDir: string, private readonly store: RunStore, private readonly manager: RunManager,
    private readonly clock: () => number = Date.now) {
    this.path = join(dataDir, 'workflow-actions.ndjson');
  }

  snapshot(runId: string): string | null {
    const run = this.store.getRun(runId);
    return run ? createHash('sha256').update(JSON.stringify({ status: run.status, execution: run.workflowExecution ?? null, steps: run.steps })).digest('hex') : null;
  }

  history(runId: string): WorkflowActionRecord[] {
    try {
      return readFileSync(this.path, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
        try { const entry = JSON.parse(line) as WorkflowActionRecord; return entry.runId === runId ? [entry] : []; }
        catch { return []; }
      });
    } catch { return []; }
  }

  async submit(principal: WorkflowActionPrincipal, input: WorkflowActionInput): Promise<{ ok: boolean; replayed?: boolean; error?: string; record?: WorkflowActionRecord }> {
    const previous = this.locks.get(input.runId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.locks.set(input.runId, queued);
    await previous;
    try { return await this.apply(principal, input); }
    finally { release(); if (this.locks.get(input.runId) === queued) this.locks.delete(input.runId); }
  }

  private async apply(principal: WorkflowActionPrincipal, input: WorkflowActionInput) {
    const entries = this.history(input.runId);
    const prior = entries.find((entry) => entry.idempotencyKey === input.idempotencyKey);
    if (prior) {
      if (prior.actor !== principal.actor || prior.action !== input.action || prior.expectedVersion !== input.expectedVersion) return { ok: false, error: 'idempotency key reused for a different action' };
      const latest = [...entries].reverse().find((entry) => entry.idempotencyKey === input.idempotencyKey)!;
      return latest.phase === 'completed' && latest.result !== 'not-cancelable' ? { ok: true, replayed: true, record: latest }
        : latest.phase === 'completed' ? { ok: false, replayed: true, error: 'run is not cancelable', record: latest }
        : { ok: false, replayed: true, error: 'prior action was not completed; use a new key after resolving it', record: latest };
    }
    const auditInput = { idempotencyKey: input.idempotencyKey, action: input.action, runId: input.runId, expectedVersion: input.expectedVersion };
    if (!principal.actor || !principal.roles.includes(permission[input.action])) {
      const denied: WorkflowActionRecord = { ...auditInput, actor: principal.actor || 'unknown', phase: 'denied', at: new Date(this.clock()).toISOString(), result: 'forbidden' };
      this.persist(denied);
      return { ok: false, error: 'forbidden', record: denied };
    }
    const run = this.store.getRun(input.runId);
    const reject = (reason: string) => {
      const record: WorkflowActionRecord = { ...auditInput, actor: principal.actor, phase: 'rejected', at: new Date(this.clock()).toISOString(), result: reason };
      this.persist(record);
      return { ok: false as const, error: reason, record };
    };
    if (!run) return reject('unknown run');
    if (this.snapshot(input.runId) !== input.expectedVersion) return reject('stale run snapshot');
    if (input.action === 'approve' && (!run.workflowExecution || run.workflowExecution.wait?.reason !== 'human')) return reject('run is not waiting at a human gate');
    if (input.action === 'resume' && (!run.workflowExecution || run.workflowExecution.wait?.reason !== 'human')) return reject('run is not waiting for a human resume');
    const started: WorkflowActionRecord = { ...auditInput, actor: principal.actor, phase: 'started', at: new Date(this.clock()).toISOString() };
    this.persist(started);
    try {
      let result: string;
      switch (input.action) {
        case 'cancel': result = this.manager.cancel(input.runId) ? 'cancelled' : 'not-cancelable'; break;
        case 'resume':
        case 'approve': {
          const resumed = this.manager.resumeVersionedRun(input.runId, { kind: 'human' });
          if (!resumed.ok) throw new Error(resumed.error ?? 'resume rejected');
          result = input.action === 'approve' ? 'approved-and-resumed' : 'resumed'; break;
        }
        case 'reconcile': await this.manager.recover(input.runId); result = 'reconciled'; break;
        case 'escalate':
          this.store.appendEvent(input.runId, { type: 'operator-action', action: 'escalate', actor: principal.actor, message: 'Operator escalated this workflow for review.' });
          result = 'escalated'; break;
      }
      const completed: WorkflowActionRecord = { ...started, phase: 'completed', at: new Date(this.clock()).toISOString(), result };
      this.persist(completed);
      return { ok: result !== 'not-cancelable', record: completed, ...(result === 'not-cancelable' ? { error: 'run is not cancelable' } : {}) };
    } catch (error) {
      // Error messages may contain repository paths, prompts or provider output. Keep only a
      // stable audit status; detailed diagnostics remain in the existing redacted run history.
      void error;
      const failed: WorkflowActionRecord = { ...started, phase: 'failed', at: new Date(this.clock()).toISOString(), result: 'action failed; inspect run history' };
      this.persist(failed);
      return { ok: false, error: failed.result, record: failed };
    }
  }

  private persist(record: WorkflowActionRecord): void {
    mkdirSync(this.dataDir, { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, 'utf8');
  }
}

const services = new WeakMap<RunStore, WorkflowActionService>();
export function workflowActionService(dataDir: string, store: RunStore, manager: RunManager): WorkflowActionService {
  let service = services.get(store);
  if (!service) { service = new WorkflowActionService(dataDir, store, manager); services.set(store, service); }
  return service;
}
