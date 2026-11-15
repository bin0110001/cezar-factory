import { redactError } from './worker-read-model.ts';

/**
 * Scenario/run operations projection and operator action guard (#219, slice 2).
 * Pure: no store, scheduler or HTTP. Existing run/release pages stay canonical;
 * these functions compose into them. Traces are diagnostic only and never count
 * as evidence of a result.
 */

export const SCENARIO_OPS_VERSION = 1;

export type OutcomeKind = 'pass' | 'assertion-failure' | 'infra-failure' | 'canceled' | 'pending';

export interface RolePartition {
  runId: string;
  scenarioId: string;
  shard: string;
  role: string;
  attemptId?: string;
  workerId?: string;
  state: 'queued' | 'running' | 'finished' | 'canceled' | 'released';
  outcome?: 'pass' | 'assertion-failure' | 'infra-failure';
  startedAt?: string;
  finishedAt?: string;
  /** Evidence artifact ids from the canonical artifact store (never media bytes). */
  evidenceIds?: string[];
  /** Evidence the scenario requires from this role. */
  requiredEvidence?: string[];
  error?: string;
  /** Stable correlation id for traces; diagnostic only. */
  traceId?: string;
}

export interface PartitionView {
  shard: string;
  role: string;
  attemptId: string | null;
  workerId: string | null;
  state: RolePartition['state'];
  outcome: OutcomeKind;
  durationMs: number | null;
  evidenceIds: string[];
  missingEvidence: string[];
  error: string | null;
  traceId: string | null;
  /** Why it is not running, when queued. */
  queuedBecause: string | null;
}

export interface ScenarioView {
  schemaVersion: typeof SCENARIO_OPS_VERSION;
  runId: string;
  scenarioId: string;
  partitions: PartitionView[];
  /** complete only when every declared role has finished with all required evidence. */
  coverage: { expectedRoles: string[]; missingRoles: string[]; complete: boolean };
  outcome: OutcomeKind;
  infraFailures: number;
  assertionFailures: number;
  missingEvidenceCount: number;
}

function outcomeOf(p: RolePartition): OutcomeKind {
  if (p.state === 'canceled' || p.state === 'released') return 'canceled';
  if (p.state !== 'finished') return 'pending';
  return p.outcome ?? 'infra-failure'; // finished without a verdict is never a pass
}

export function projectScenario(
  runId: string,
  scenarioId: string,
  expectedRoles: string[],
  partitions: RolePartition[],
  queueReasons: Record<string, string> = {},
): ScenarioView {
  const mine = partitions.filter((p) => p.runId === runId && p.scenarioId === scenarioId);
  const views = mine
    .map((p): PartitionView => {
      const have = new Set(p.evidenceIds ?? []);
      const missing = (p.requiredEvidence ?? []).filter((e) => !have.has(e));
      const s = p.startedAt ? Date.parse(p.startedAt) : NaN;
      const f = p.finishedAt ? Date.parse(p.finishedAt) : NaN;
      return {
        shard: p.shard,
        role: p.role,
        attemptId: p.attemptId ?? null,
        workerId: p.workerId ?? null,
        state: p.state,
        outcome: outcomeOf(p),
        durationMs: Number.isFinite(s) && Number.isFinite(f) && f >= s ? f - s : null,
        evidenceIds: [...(p.evidenceIds ?? [])],
        missingEvidence: missing,
        error: redactError(p.error),
        traceId: p.traceId ?? null,
        queuedBecause: p.state === 'queued' ? (queueReasons[`${p.shard}:${p.role}`] ?? 'unexplained') : null,
      };
    })
    .sort((a, b) => a.shard.localeCompare(b.shard) || a.role.localeCompare(b.role));

  const finishedRoles = new Set(views.filter((v) => v.state === 'finished' && v.missingEvidence.length === 0).map((v) => v.role));
  const missingRoles = expectedRoles.filter((r) => !finishedRoles.has(r));
  const infra = views.filter((v) => v.outcome === 'infra-failure').length;
  const assertion = views.filter((v) => v.outcome === 'assertion-failure').length;
  const missingEvidenceCount = views.reduce((n, v) => n + v.missingEvidence.length, 0);
  const complete = missingRoles.length === 0 && views.length > 0;
  let outcome: OutcomeKind;
  if (assertion > 0) outcome = 'assertion-failure';
  else if (infra > 0) outcome = 'infra-failure';
  else if (views.some((v) => v.outcome === 'canceled')) outcome = 'canceled';
  else if (!complete || views.some((v) => v.outcome === 'pending')) outcome = 'pending';
  else outcome = 'pass';
  return {
    schemaVersion: SCENARIO_OPS_VERSION,
    runId,
    scenarioId,
    partitions: views,
    coverage: { expectedRoles: [...expectedRoles], missingRoles, complete },
    outcome,
    infraFailures: infra,
    assertionFailures: assertion,
    missingEvidenceCount,
  };
}

// ---------------------------------------------------------------- operator actions

export type OperatorActionKind =
  | 'enroll-link' | 'revoke' | 'drain' | 'undrain' | 'quarantine'
  | 'cancel' | 'retry' | 'set-profile' | 'schedule-dry-run';

export type Permission = 'worker:read' | 'worker:admin' | 'run:cancel' | 'run:retry' | 'schedule:explain';

const REQUIRED: Record<OperatorActionKind, Permission> = {
  'enroll-link': 'worker:admin',
  revoke: 'worker:admin',
  drain: 'worker:admin',
  undrain: 'worker:admin',
  quarantine: 'worker:admin',
  'set-profile': 'worker:admin',
  cancel: 'run:cancel',
  retry: 'run:retry',
  'schedule-dry-run': 'schedule:explain',
};

export interface OperatorRequest {
  idempotencyKey: string;
  actor: string;
  permissions: Permission[];
  action: OperatorActionKind;
  target: string;
  /** Retry only: the target partition's current outcome, as read by the caller. */
  targetOutcome?: OutcomeKind;
}

export interface AuditEntry {
  at: string;
  actor: string;
  action: OperatorActionKind;
  target: string;
  result: 'applied' | 'denied' | 'rejected' | 'replayed';
  reason?: string;
  idempotencyKey: string;
}

export type OperatorResult =
  | { ok: true; replayed: boolean; audit: AuditEntry }
  | { ok: false; code: 'forbidden' | 'invalid' | 'ineligible'; audit: AuditEntry };

/**
 * Authorizes, deduplicates and audits operator actions, then delegates the
 * mutation to the existing controller API via `apply`. Keeps no scheduler state.
 */
export class OperatorActionGuard {
  private readonly seen = new Map<string, { fingerprint: string; result: OperatorResult }>();
  readonly audit: AuditEntry[] = [];

  constructor(
    private readonly apply: (req: OperatorRequest) => void,
    private readonly clock: () => number = Date.now,
  ) {}

  private record(req: OperatorRequest, result: AuditEntry['result'], reason?: string): AuditEntry {
    const entry: AuditEntry = {
      at: new Date(this.clock()).toISOString(),
      actor: req.actor,
      action: req.action,
      target: req.target,
      result,
      idempotencyKey: req.idempotencyKey,
      ...(reason ? { reason } : {}),
    };
    this.audit.push(entry);
    return entry;
  }

  execute(req: OperatorRequest): OperatorResult {
    if (!req.idempotencyKey || !req.actor || !req.target || !(req.action in REQUIRED)) {
      return { ok: false, code: 'invalid', audit: this.record(req, 'rejected', 'invalid request') };
    }
    const fingerprint = `${req.action}\u0000${req.target}\u0000${req.actor}`;
    const prior = this.seen.get(req.idempotencyKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        return { ok: false, code: 'invalid', audit: this.record(req, 'rejected', 'idempotency key reused for a different request') };
      }
      const audit = this.record(req, 'replayed');
      return prior.result.ok ? { ok: true, replayed: true, audit } : { ...prior.result, audit };
    }
    const need = REQUIRED[req.action];
    if (!req.permissions.includes(need)) {
      const result: OperatorResult = { ok: false, code: 'forbidden', audit: this.record(req, 'denied', `missing ${need}`) };
      this.seen.set(req.idempotencyKey, { fingerprint, result });
      return result;
    }
    if (req.action === 'retry' && req.targetOutcome !== 'infra-failure' && req.targetOutcome !== 'canceled') {
      // Assertion failures are real signal; passing/pending partitions need no retry.
      const result: OperatorResult = { ok: false, code: 'ineligible', audit: this.record(req, 'rejected', `not retryable: ${req.targetOutcome ?? 'unknown'}`) };
      this.seen.set(req.idempotencyKey, { fingerprint, result });
      return result;
    }
    this.apply(req);
    const result: OperatorResult = { ok: true, replayed: false, audit: this.record(req, 'applied') };
    this.seen.set(req.idempotencyKey, { fingerprint, result });
    return result;
  }
}
