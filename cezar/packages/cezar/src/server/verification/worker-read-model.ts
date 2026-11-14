import { matchRequirements, type JobRequirements, type WorkerCapabilities } from './worker-capabilities.ts';

/**
 * Worker operations read model (#219). A pure projection over worker records,
 * heartbeats and attempt state; it owns no store and no scheduler. Staleness is
 * fail-closed: a worker is only `healthy` when its heartbeat is fresh and no
 * operator hold applies. Unknown, stale and offline never render as healthy.
 */

export const WORKER_READ_MODEL_VERSION = 1;

export type WorkerOperatorState = 'active' | 'draining' | 'quarantined' | 'revoked';
export type WorkerStatus = 'healthy' | 'stale' | 'offline' | 'unknown' | 'draining' | 'quarantined' | 'revoked';

export interface WorkerRecord {
  id: string;
  version?: string;
  capabilities: WorkerCapabilities;
  operatorState?: WorkerOperatorState;
  /** ISO timestamp of the last heartbeat, if any was ever received. */
  lastHeartbeatAt?: string;
  maxConcurrency?: number;
  /** Raw last error; redacted before it leaves this module. */
  lastError?: string;
  /** Authorized asset locality labels only (never host paths). */
  assetLocality?: string[];
}

export interface WorkerAttempt {
  attemptId: string;
  runId: string;
  scenarioId?: string;
  workerId: string;
  state: 'queued' | 'running' | 'canceled' | 'released';
}

export interface WorkerFreshness {
  staleAfterMs: number;
  offlineAfterMs: number;
}
export const DEFAULT_FRESHNESS: WorkerFreshness = { staleAfterMs: 30_000, offlineAfterMs: 120_000 };

export interface WorkerView {
  id: string;
  version: string | null;
  status: WorkerStatus;
  heartbeatAgeMs: number | null;
  capabilities: WorkerCapabilities;
  capacity: { max: number | null; reserved: number; available: number | null };
  activeAttempts: string[];
  queuedAttempts: string[];
  assetLocality: string[];
  lastError: string | null;
}

export interface WorkerPage {
  schemaVersion: typeof WORKER_READ_MODEL_VERSION;
  workers: WorkerView[];
  nextCursor: string | null;
}

const MAX_ERROR_CHARS = 200;
export const MAX_PAGE_SIZE = 100;

/** Strip secrets, URL credentials and filesystem paths; bound the length. */
export function redactError(raw: string | undefined): string | null {
  if (!raw) return null;
  let s = raw
    .replace(/\b(?:[a-z][a-z0-9+.-]*):\/\/[^\s/@]+@/gi, (m) => m.replace(/\/\/[^@]*@/, '//[redacted]@'))
    .replace(/\b(token|secret|password|passwd|api[_-]?key|authorization)(\s*[=:]\s*|\s+)(?:bearer\s+)?\S+/gi, '$1=[redacted]')
    .replace(/\b(?:gh[pousr]_|sk-)[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/(?:[A-Za-z]:\\[^\s]*|(?:\/[\w.@-]+){2,})/g, '[path]')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > MAX_ERROR_CHARS) s = `${s.slice(0, MAX_ERROR_CHARS)}…`;
  return s;
}

export function deriveWorkerStatus(w: WorkerRecord, now: number, f: WorkerFreshness = DEFAULT_FRESHNESS): { status: WorkerStatus; ageMs: number | null } {
  const beat = w.lastHeartbeatAt ? Date.parse(w.lastHeartbeatAt) : NaN;
  const ageMs = Number.isFinite(beat) ? Math.max(0, now - beat) : null;
  if (w.operatorState === 'revoked') return { status: 'revoked', ageMs };
  if (ageMs === null) return { status: 'unknown', ageMs };
  if (ageMs >= f.offlineAfterMs) return { status: 'offline', ageMs };
  if (ageMs >= f.staleAfterMs) return { status: 'stale', ageMs };
  if (w.operatorState === 'quarantined') return { status: 'quarantined', ageMs };
  if (w.operatorState === 'draining') return { status: 'draining', ageMs };
  return { status: 'healthy', ageMs };
}

export function projectWorkers(
  workers: WorkerRecord[],
  attempts: WorkerAttempt[],
  opts: { now: number; freshness?: WorkerFreshness; limit?: number; cursor?: string },
): WorkerPage {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 25)), MAX_PAGE_SIZE);
  const sorted = [...workers].sort((a, b) => a.id.localeCompare(b.id));
  const start = opts.cursor ? sorted.findIndex((w) => w.id > opts.cursor!) : 0;
  const slice = start < 0 ? [] : sorted.slice(start, start + limit);
  const views = slice.map((w): WorkerView => {
    const { status, ageMs } = deriveWorkerStatus(w, opts.now, opts.freshness);
    // Canceled/released attempts hold no capacity: worker and run views agree.
    const mine = attempts.filter((a) => a.workerId === w.id);
    const active = mine.filter((a) => a.state === 'running').map((a) => a.attemptId);
    const queued = mine.filter((a) => a.state === 'queued').map((a) => a.attemptId);
    const max = w.maxConcurrency ?? null;
    return {
      id: w.id,
      version: w.version ?? null,
      status,
      heartbeatAgeMs: ageMs,
      capabilities: w.capabilities,
      capacity: { max, reserved: active.length, available: max === null ? null : Math.max(0, max - active.length) },
      activeAttempts: active,
      queuedAttempts: queued,
      assetLocality: [...(w.assetLocality ?? [])],
      lastError: redactError(w.lastError),
    };
  });
  const last = slice[slice.length - 1];
  const more = start >= 0 && start + limit < sorted.length;
  return { schemaVersion: WORKER_READ_MODEL_VERSION, workers: views, nextCursor: more && last ? last.id : null };
}

export interface SchedulingExplanation {
  schedulable: boolean;
  /** One entry per worker explaining acceptance or why it was ruled out. */
  workers: Array<{ workerId: string; eligible: boolean; reasons: string[] }>;
  summary: string;
}

/** Dry-run: explain why a job is queued/unschedulable. Mutates nothing. */
export function explainScheduling(job: JobRequirements, workers: WorkerView[]): SchedulingExplanation {
  const rows = workers.map((w) => {
    const reasons: string[] = [];
    if (w.status !== 'healthy') reasons.push(`status:${w.status}`);
    const m = matchRequirements(w.capabilities, job);
    if (!m.schedulable) reasons.push(...m.missing.map((x) => `missing:${x}`));
    if (w.capacity.available === 0) reasons.push('capacity:full');
    return { workerId: w.id, eligible: reasons.length === 0, reasons };
  });
  const schedulable = rows.some((r) => r.eligible);
  const summary = schedulable
    ? `Runnable on ${rows.filter((r) => r.eligible).map((r) => r.workerId).join(', ')}`
    : rows.length === 0
      ? 'No workers enrolled'
      : `No eligible worker: ${rows.map((r) => `${r.workerId} (${r.reasons.join(', ')})`).join('; ')}`;
  return { schedulable, workers: rows, summary };
}
