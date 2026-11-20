import { z } from 'zod';
import {
  OperatorActionGuard,
  projectScenario,
  type AuditEntry,
  type OperatorActionKind,
  type OperatorRequest,
  type Permission,
  type RolePartition,
  type ScenarioView,
} from './scenario-operations.ts';
import { jobRequirementsSchema, parseWorkerCapabilities, type JobRequirements } from './worker-capabilities.ts';
import {
  explainScheduling,
  projectWorkers,
  redactError,
  type SchedulingExplanation,
  type WorkerAttempt,
  type WorkerPage,
  type WorkerRecord,
} from './worker-read-model.ts';

/**
 * Operator controls service (#219, slice 5). Binds the OperatorActionGuard to the
 * controller: the actor and permissions come from the authenticated principal
 * (roles mapped server-side, never from the request body), actions on one target
 * are serialised, stale targets are rejected, and every mutation goes through one
 * state (partitions) so the worker view and the run verification view agree.
 * No scheduler, no new store: state is the caller-provided in-memory controller
 * state; idempotency and audit are bounded and lost on restart (documented).
 */

export const OPERATOR_CONTROLS_VERSION = 1;

export type OperatorRole = 'viewer' | 'operator' | 'admin';

/** Role -> permissions. Unknown roles grant nothing (fail closed). */
export const ROLE_PERMISSIONS: Record<OperatorRole, Permission[]> = {
  viewer: ['worker:read'],
  operator: ['worker:read', 'run:cancel', 'run:retry', 'schedule:explain'],
  admin: ['worker:read', 'worker:admin', 'run:cancel', 'run:retry', 'schedule:explain'],
};

/** The authenticated principal as produced by the existing controller auth. */
export interface Principal {
  actor: string;
  roles: string[];
}

export function permissionsFor(principal: Principal): Permission[] {
  const out = new Set<Permission>();
  for (const r of principal.roles) {
    const perms = (ROLE_PERMISSIONS as Record<string, Permission[] | undefined>)[r];
    for (const p of perms ?? []) out.add(p);
  }
  return [...out];
}

const TARGET_RE = /^[A-Za-z0-9:._-]{1,128}$/;
const PROFILE_RE = /^[a-z0-9._-]{1,64}$/;

export const operatorControlRequestSchema = z.object({
  schemaVersion: z.literal(OPERATOR_CONTROLS_VERSION).default(OPERATOR_CONTROLS_VERSION),
  idempotencyKey: z.string().min(1).max(128),
  action: z.enum(['enroll-link', 'revoke', 'drain', 'undrain', 'quarantine', 'cancel', 'retry', 'set-profile', 'schedule-dry-run']),
  /** worker id, attempt id (cancel), `runId:scenarioId:shard:role` partition (retry), or job id (dry-run). */
  target: z.string().regex(TARGET_RE),
  /** Optional compare-and-set: the target version the operator's view was rendered from. */
  expectedVersion: z.string().max(32).optional(),
  profile: z.string().regex(PROFILE_RE).optional(),
  requirements: jobRequirementsSchema.optional(),
});
export type OperatorControlRequest = z.infer<typeof operatorControlRequestSchema>;

export interface OperatorControlResponse {
  schemaVersion: typeof OPERATOR_CONTROLS_VERSION;
  ok: boolean;
  replayed: boolean;
  code?: 'forbidden' | 'invalid' | 'ineligible';
  audit: AuditEntry;
  targetVersion: string | null;
  explanation?: SchedulingExplanation;
}

export class OperatorControls {
  private readonly workers = new Map<string, WorkerRecord>();
  private readonly profiles = new Map<string, string>();
  private partitions: RolePartition[] = [];
  private readonly versions = new Map<string, number>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly guard: OperatorActionGuard;
  private current: OperatorControlRequest | undefined;
  private explanation: SchedulingExplanation | undefined;

  constructor(private readonly clock: () => number = Date.now) {
    this.guard = new OperatorActionGuard((req) => this.apply(req), clock, { preflight: (req) => this.preflight(req) });
  }

  // ---- state seeding / reads (the existing controller owns the real data)
  upsertWorker(w: WorkerRecord): void { this.workers.set(w.id, w); }
  setPartitions(p: RolePartition[]): void { this.partitions = p; }
  profileOf(workerId: string): string | null { return this.profiles.get(workerId) ?? null; }
  get audit(): readonly AuditEntry[] { return this.guard.audit; }

  version(target: string): string { return `v${this.versions.get(target) ?? 0}`; }
  private bump(target: string): void { this.versions.set(target, (this.versions.get(target) ?? 0) + 1); }

  /** Attempts are derived from partitions, so worker and run views cannot disagree. */
  attempts(): WorkerAttempt[] {
    return this.partitions
      .filter((p) => p.attemptId && p.workerId)
      .map((p) => ({
        attemptId: p.attemptId!,
        runId: p.runId,
        scenarioId: p.scenarioId,
        workerId: p.workerId!,
        traceId: p.traceId,
        state: p.state === 'finished' ? ('released' as const) : p.state,
      }));
  }

  workerPage(opts: { limit?: number; cursor?: string } = {}): WorkerPage {
    return projectWorkers([...this.workers.values()], this.attempts(), { now: this.clock(), ...opts });
  }

  scenarioView(runId: string, scenarioId: string, expectedRoles: string[]): ScenarioView {
    return projectScenario(runId, scenarioId, expectedRoles, this.partitions);
  }

  private partitionKey(p: RolePartition): string { return `${p.runId}:${p.scenarioId}:${p.shard}:${p.role}`; }
  private findPartition(target: string): RolePartition | undefined {
    return this.partitions.find((p) => this.partitionKey(p) === target);
  }
  private findByAttempt(attemptId: string): RolePartition | undefined {
    return this.partitions.find((p) => p.attemptId === attemptId);
  }

  private targetExists(req: OperatorRequest): boolean {
    switch (req.action) {
      case 'enroll-link':
      case 'schedule-dry-run': return true;
      case 'cancel': return !!this.findByAttempt(req.target);
      case 'retry': return !!this.findPartition(req.target);
      default: return this.workers.has(req.target);
    }
  }

  private preflight(req: OperatorRequest): string | undefined {
    if (!this.targetExists(req)) return 'unknown target';
    const expected = this.current?.expectedVersion;
    if (expected !== undefined && expected !== this.version(req.target)) return 'stale target';
    if (req.action === 'cancel') {
      const p = this.findByAttempt(req.target)!;
      if (p.state === 'finished' || p.state === 'canceled' || p.state === 'released') return 'attempt not cancelable';
    }
    if (req.action === 'set-profile' && !this.current?.profile) return 'profile required';
    return undefined;
  }

  private apply(req: OperatorRequest): void {
    const cur = this.current!;
    const release = (p: RolePartition, state: 'canceled' | 'released') => {
      p.state = state;
      p.finishedAt = new Date(this.clock()).toISOString();
    };
    switch (req.action) {
      case 'enroll-link':
        // Enrollment only registers an unknown (never healthy) worker; the join secret is never stored or returned.
        if (!this.workers.has(req.target)) this.workers.set(req.target, { id: req.target, capabilities: parseWorkerCapabilities({}) });
        break;
      case 'revoke':
        this.workers.get(req.target)!.operatorState = 'revoked';
        for (const p of this.partitions) if (p.workerId === req.target && (p.state === 'running' || p.state === 'queued')) release(p, 'released');
        break;
      case 'drain': this.workers.get(req.target)!.operatorState = 'draining'; break;
      case 'undrain': this.workers.get(req.target)!.operatorState = 'active'; break;
      case 'quarantine': this.workers.get(req.target)!.operatorState = 'quarantined'; break;
      case 'set-profile': this.profiles.set(req.target, cur.profile!); break;
      case 'cancel': release(this.findByAttempt(req.target)!, 'canceled'); break;
      case 'retry': {
        const p = this.findPartition(req.target)!;
        p.state = 'queued';
        delete p.outcome;
        delete p.finishedAt;
        delete p.error;
        break;
      }
      case 'schedule-dry-run': {
        const page = this.workerPage({ limit: 100 });
        this.explanation = explainScheduling((cur.requirements ?? {}) as JobRequirements, page.workers);
        return; // read-only: no version bump
      }
    }
    this.bump(req.target);
  }

  /** Serialises per target; same-target actions run one at a time in arrival order. */
  async submit(principal: Principal, body: unknown): Promise<OperatorControlResponse> {
    const parsed = operatorControlRequestSchema.safeParse(body);
    if (!parsed.success) {
      // Malformed bodies are rejected and audited by the guard (never applied).
      const r = this.guard.execute({
        idempotencyKey: '', actor: principal.actor, permissions: [], action: 'unknown' as OperatorActionKind, target: '',
      });
      return { schemaVersion: OPERATOR_CONTROLS_VERSION, ok: false, replayed: false, code: 'invalid', audit: r.audit, targetVersion: null };
    }
    const req = parsed.data;
    const prev = this.queues.get(req.target) ?? Promise.resolve();
    const run = prev.then(() => this.runOne(principal, req));
    const tail = run.catch(() => undefined);
    this.queues.set(req.target, tail);
    void tail.then(() => { if (this.queues.get(req.target) === tail) this.queues.delete(req.target); });
    return run;
  }

  private runOne(principal: Principal, req: OperatorControlRequest): OperatorControlResponse {
    const op: OperatorRequest = {
      idempotencyKey: req.idempotencyKey,
      actor: principal.actor,
      permissions: permissionsFor(principal), // never client supplied
      action: req.action,
      target: req.target,
    };
    if (req.action === 'retry') op.targetOutcome = this.partitionOutcome(req.target); // read server-side
    this.current = req;
    this.explanation = undefined;
    try {
      const r = this.guard.execute(op);
      const audit: AuditEntry = { ...r.audit, ...(r.audit.reason ? { reason: redactError(r.audit.reason) ?? '' } : {}) };
      return {
        schemaVersion: OPERATOR_CONTROLS_VERSION,
        ok: r.ok,
        replayed: r.ok ? r.replayed : r.audit.result === 'replayed',
        ...(r.ok ? {} : { code: r.code }),
        audit,
        targetVersion: this.targetExists(op) ? this.version(req.target) : null,
        ...(r.ok && !r.replayed && this.explanation ? { explanation: this.explanation } : {}),
      };
    } finally {
      this.current = undefined;
    }
  }

  private partitionOutcome(target: string) {
    const p = this.findPartition(target);
    if (!p) return undefined;
    return projectScenario(p.runId, p.scenarioId, [p.role], [p]).partitions[0]?.outcome;
  }
}
