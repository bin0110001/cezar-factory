import { join } from 'node:path';
import type { CodingFailureReason, CodingRunEvent, CodingRunSnapshot } from '@open-mercato/cezar-contract';

/**
 * Bounded coding-run lifecycle. This is a pure policy layer over the existing run ledger
 * (`lifecycle.ts`): it adds no scheduler, store or workflow engine. The ledger remains the single
 * source of truth; every function here reads a snapshot and returns a decision.
 */

export const LIFECYCLE_STAGES = ['prepare', 'context', 'implement', 'validate', 'repair', 'deliver', 'learn'] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];
export type EventType = CodingRunEvent['type'];

const STAGE_OF: Partial<Record<EventType, LifecycleStage>> = {
  'run.started': 'prepare', 'attempt.started': 'prepare', 'context.prepared': 'context',
  'implementation.started': 'implement', 'implementation.completed': 'implement',
  'validation.completed': 'validate', 'repair.started': 'repair', 'repair.completed': 'repair',
  'delivery.opened': 'deliver', 'delivery.merged': 'deliver', 'delivery.rejected': 'deliver', 'delivery.reverted': 'deliver',
  'learning.recorded': 'learn',
};

/** Stage an event belongs to; terminal events have no stage. */
export function stageOfEvent(type: EventType): LifecycleStage | undefined {
  return STAGE_OF[type];
}

const ATTEMPT_END: EventType[] = ['attempt.failed', 'attempt.cancelled', 'attempt.superseded'];
/** Events that may follow the last stage event of the active attempt. */
const NEXT_IN_ATTEMPT: Partial<Record<EventType, EventType[]>> = {
  'attempt.started': ['context.prepared', ...ATTEMPT_END],
  'context.prepared': ['implementation.started', ...ATTEMPT_END],
  'implementation.started': ['implementation.completed', ...ATTEMPT_END],
  'implementation.completed': ['validation.completed', ...ATTEMPT_END],
  'validation.completed': ['repair.started', 'attempt.completed', ...ATTEMPT_END],
  'repair.started': ['repair.completed', ...ATTEMPT_END],
  'repair.completed': ['validation.completed', ...ATTEMPT_END],
};
const ATTEMPT_SCOPED: EventType[] = ['context.prepared', 'implementation.started', 'implementation.completed', 'validation.completed',
  'repair.started', 'repair.completed', 'attempt.completed', 'attempt.failed', 'attempt.cancelled', 'attempt.superseded'];

export interface TransitionRequest { type: EventType; attemptId?: string; reason?: CodingFailureReason }
export type TransitionCheck = { ok: true } | { ok: false; code: 'stale-attempt' | 'out-of-order' | 'duplicate-delivery' | 'terminal' | 'bad-reason'; detail: string };

/** Delivery side effects still in force: opened and neither rejected nor reverted afterwards. */
export function liveDelivery(snapshot: CodingRunSnapshot): { opened: boolean; merged: boolean } {
  let opened = false;
  let merged = false;
  for (const event of snapshot.events) {
    if (event.type === 'delivery.opened') { opened = true; merged = false; }
    else if (event.type === 'delivery.merged') merged = true;
    else if (event.type === 'delivery.rejected') { opened = false; merged = false; }
    else if (event.type === 'delivery.reverted') { opened = false; merged = false; }
  }
  return { opened: opened || merged, merged };
}

function lastEventOfAttempt(snapshot: CodingRunSnapshot, attemptId: string): EventType | undefined {
  for (let index = snapshot.events.length - 1; index >= 0; index -= 1) {
    const event = snapshot.events[index]!;
    if (event.attemptId === attemptId && NEXT_IN_ATTEMPT[event.type]) return event.type;
  }
  return undefined;
}

/**
 * Validate one prospective ledger event against the Prepare→Context→Implement→Validate→Repair→
 * Deliver→Learn order. Only new appends are checked; replay of stored history is never rejected.
 */
export function checkCodingRunTransition(snapshot: CodingRunSnapshot, request: TransitionRequest): TransitionCheck {
  const { type } = request;
  if (type === 'run.started') return { ok: true };
  if (snapshot.run.status !== 'running') return { ok: false, code: 'terminal', detail: `${type} after the run finished` };
  if (request.reason && !['attempt.failed', 'attempt.cancelled', 'delivery.rejected', 'run.failed', 'run.cancelled'].includes(type)) {
    return { ok: false, code: 'bad-reason', detail: `${type} cannot carry a failure reason` };
  }
  if (type === 'attempt.cancelled' && request.reason && request.reason !== 'cancelled') {
    return { ok: false, code: 'bad-reason', detail: 'attempt.cancelled carries reason "cancelled" only' };
  }
  const active = snapshot.attempts.find((attempt) => attempt.status === 'running');
  if (ATTEMPT_SCOPED.includes(type)) {
    if (!active) return { ok: false, code: 'stale-attempt', detail: `${type} has no active attempt (result of a finished or superseded attempt)` };
    if (request.attemptId && request.attemptId !== active.attemptId) {
      return { ok: false, code: 'stale-attempt', detail: `${type} names ${request.attemptId}, active attempt is ${active.attemptId}` };
    }
    const last = lastEventOfAttempt(snapshot, active.attemptId);
    const allowed = last ? NEXT_IN_ATTEMPT[last] : undefined;
    if (!allowed?.includes(type)) return { ok: false, code: 'out-of-order', detail: `${type} cannot follow ${last ?? 'nothing'}` };
    return { ok: true };
  }
  if (type === 'delivery.opened') {
    if (liveDelivery(snapshot).opened) return { ok: false, code: 'duplicate-delivery', detail: 'delivery is already open for this run' };
    const finished = [...snapshot.attempts].sort((a, b) => b.index - a.index)[0];
    if (active || finished?.status !== 'completed') return { ok: false, code: 'out-of-order', detail: 'delivery requires a completed, validated latest attempt' };
    return { ok: true };
  }
  if (type === 'delivery.merged') {
    const live = liveDelivery(snapshot);
    if (!live.opened) return { ok: false, code: 'out-of-order', detail: 'delivery.merged requires an open delivery' };
    if (live.merged) return { ok: false, code: 'duplicate-delivery', detail: 'delivery is already merged' };
    return { ok: true };
  }
  if (type === 'delivery.rejected') return liveDelivery(snapshot).opened ? { ok: true } : { ok: false, code: 'out-of-order', detail: 'delivery.rejected requires an open delivery' };
  if (type === 'delivery.reverted') return liveDelivery(snapshot).merged ? { ok: true } : { ok: false, code: 'out-of-order', detail: 'delivery.reverted requires a merged delivery' };
  if (type === 'learning.recorded' && active) return { ok: false, code: 'out-of-order', detail: 'learning is recorded after the attempt ends' };
  return { ok: true };
}

export interface LifecycleBudgets {
  maxAttempts: number;
  /** Infrastructure failures retried with a new attempt. */
  maxInfraRetries: number;
  /** Test/parse repair rounds per run; each repair is bounded (#105 owns the repair itself). */
  maxRepairs: number;
  /** Capacity waits before re-routing to another worker/model; waits never consume a retry. */
  maxCapacityWaits: number;
  /** Per-stage wall-clock limits in ms; a stage past its limit is a bounded failure, not a hang. */
  stageDeadlineMs: Partial<Record<LifecycleStage, number>>;
}
export const DEFAULT_LIFECYCLE_BUDGETS: LifecycleBudgets = {
  maxAttempts: 5, maxInfraRetries: 2, maxRepairs: 2, maxCapacityWaits: 6,
  stageDeadlineMs: { prepare: 600_000, context: 900_000, implement: 5_400_000, validate: 1_800_000, repair: 2_700_000, deliver: 600_000, learn: 600_000 },
};

export type LifecycleDecision =
  | { action: 'retry'; reason: 'infra'; backoffMs: number; supersedes: string }
  | { action: 'wait'; reason: 'capacity'; waitMs: number }
  | { action: 'reroute'; reason: 'capacity' }
  | { action: 'repair'; reason: 'parse' | 'test'; round: number }
  | { action: 'block'; reason: 'policy' }
  | { action: 'cancel'; reason: 'cancelled' }
  | { action: 'fail'; reason: 'budget-exhausted'; exhausted: 'attempts' | 'infra-retries' | 'repairs' | 'capacity-waits' };

/** Failure reasons recorded on the run's events, counted from the ledger so restarts cannot reset them. */
export function lifecycleCounters(snapshot: CodingRunSnapshot): { infra: number; capacity: number; repairs: number; attempts: number } {
  let infra = 0; let capacity = 0; let repairs = 0;
  for (const event of snapshot.events) {
    if (event.type === 'repair.started') repairs += 1;
    if (event.type === 'attempt.failed' && event.reason === 'infra') infra += 1;
    if (event.type === 'attempt.failed' && event.reason === 'capacity') capacity += 1;
  }
  return { infra, capacity, repairs, attempts: snapshot.attempts.length };
}

/**
 * Map a typed failure to its distinct semantics:
 * infra → bounded retry in a fresh attempt; capacity → wait, then re-route (no retry consumed);
 * parse/test → bounded repair; policy → terminal block, never retried; cancelled → terminal cancel.
 */
export function decideAfterFailure(snapshot: CodingRunSnapshot, reason: CodingFailureReason, budgets: LifecycleBudgets = DEFAULT_LIFECYCLE_BUDGETS): LifecycleDecision {
  const counts = lifecycleCounters(snapshot);
  const supersedes = [...snapshot.attempts].sort((a, b) => b.index - a.index)[0]?.attemptId ?? '';
  switch (reason) {
    case 'policy': return { action: 'block', reason: 'policy' };
    case 'cancelled': return { action: 'cancel', reason: 'cancelled' };
    case 'budget-exhausted': return { action: 'fail', reason: 'budget-exhausted', exhausted: 'attempts' };
    case 'capacity':
      // counts include the failure being decided on only when it was already recorded.
      if (counts.capacity >= budgets.maxCapacityWaits) return { action: 'reroute', reason: 'capacity' };
      return { action: 'wait', reason: 'capacity', waitMs: Math.min(300_000, 5_000 * 2 ** counts.capacity) };
    case 'parse':
    case 'test':
      if (counts.repairs >= budgets.maxRepairs) return { action: 'fail', reason: 'budget-exhausted', exhausted: 'repairs' };
      return { action: 'repair', reason, round: counts.repairs + 1 };
    case 'infra':
      if (counts.attempts >= budgets.maxAttempts) return { action: 'fail', reason: 'budget-exhausted', exhausted: 'attempts' };
      if (counts.infra >= budgets.maxInfraRetries) return { action: 'fail', reason: 'budget-exhausted', exhausted: 'infra-retries' };
      return { action: 'retry', reason: 'infra', backoffMs: Math.min(120_000, 2_000 * 2 ** counts.infra), supersedes };
  }
}

export type ResumePlan =
  | { action: 'none'; why: 'run-finished' }
  | { action: 'start-attempt'; supersedes?: string }
  | { action: 'continue'; attemptId: string; stage: LifecycleStage; next: EventType[] }
  | { action: 'abandon-attempt'; attemptId: string; reason: 'infra'; why: 'stage-deadline' | 'worker-lost' }
  | { action: 'await-delivery'; delivery: 'opened' | 'merged' };

/**
 * Decide how to resume a run after a restart from the ledger alone. Delivery that already happened
 * is never repeated; an attempt past its stage deadline is abandoned as an infra failure so a later
 * retry runs in a fresh worktree; a worker that is known to be gone is treated the same way.
 */
export function planResume(snapshot: CodingRunSnapshot, now: Date, opts: { workerAlive?: boolean; budgets?: LifecycleBudgets } = {}): ResumePlan {
  const budgets = opts.budgets ?? DEFAULT_LIFECYCLE_BUDGETS;
  if (snapshot.run.status !== 'running') return { action: 'none', why: 'run-finished' };
  const active = snapshot.attempts.find((attempt) => attempt.status === 'running');
  if (active) {
    const last = lastEventOfAttempt(snapshot, active.attemptId) ?? 'attempt.started';
    const stage = stageOfEvent(last) ?? 'prepare';
    const lastAt = [...snapshot.events].reverse().find((event) => event.attemptId === active.attemptId)?.occurredAt ?? active.startedAt;
    const limit = budgets.stageDeadlineMs[stage];
    if (opts.workerAlive === false) return { action: 'abandon-attempt', attemptId: active.attemptId, reason: 'infra', why: 'worker-lost' };
    if (limit !== undefined && now.getTime() - Date.parse(lastAt) > limit) return { action: 'abandon-attempt', attemptId: active.attemptId, reason: 'infra', why: 'stage-deadline' };
    return { action: 'continue', attemptId: active.attemptId, stage, next: NEXT_IN_ATTEMPT[last] ?? [] };
  }
  const live = liveDelivery(snapshot);
  if (live.opened) return { action: 'await-delivery', delivery: live.merged ? 'merged' : 'opened' };
  const latest = [...snapshot.attempts].sort((a, b) => b.index - a.index)[0];
  return latest ? { action: 'start-attempt', supersedes: latest.attemptId } : { action: 'start-attempt' };
}

/** Terminal outcome with the distinct blocked state derived from a policy failure. */
export function terminalOutcome(snapshot: CodingRunSnapshot): 'running' | 'completed' | 'blocked' | 'failed' | 'canceled' {
  if (snapshot.run.status === 'running') return 'running';
  if (snapshot.run.status === 'completed') return 'completed';
  if (snapshot.run.status === 'cancelled') return 'canceled';
  const last = [...snapshot.events].reverse().find((event) => event.type === 'run.failed');
  return last?.reason === 'policy' ? 'blocked' : 'failed';
}

/** Each attempt owns a distinct worktree so a stale worker can never write into its successor's tree. */
export function attemptWorktreePath(root: string, runId: string, attemptId: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(root, safe(runId), safe(attemptId));
}

/** Cross-check that events and attempt records agree (ledger/audit consistency). */
export function auditLifecycleConsistency(snapshot: CodingRunSnapshot): string[] {
  const problems: string[] = [];
  for (const attempt of snapshot.attempts) {
    const ends = snapshot.events.filter((event) => event.attemptId === attempt.attemptId && ATTEMPT_END.concat('attempt.completed').includes(event.type));
    if (attempt.status === 'running' && ends.length > 0) problems.push(`attempt ${attempt.attemptId} is running but has a terminal event`);
    if (attempt.status !== 'running' && ends.length !== 1) problems.push(`attempt ${attempt.attemptId} is ${attempt.status} with ${ends.length} terminal events`);
  }
  const opened = snapshot.events.filter((event) => event.type === 'delivery.opened').length;
  const closed = snapshot.events.filter((event) => event.type === 'delivery.rejected' || event.type === 'delivery.reverted').length;
  if (opened - closed > 1) problems.push('more than one delivery is open');
  return problems;
}
