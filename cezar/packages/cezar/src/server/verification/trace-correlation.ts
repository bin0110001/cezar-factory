import { createLangfuseTraceUrl } from '../../observability/trace-context.ts';
import { redactError } from './worker-read-model.ts';
import type { RolePartition } from './scenario-operations.ts';

/**
 * Ledger/trace correlation (#219 slice 4). Pure and diagnostic only: joins
 * event-ledger refs and trace ids to runs/attempts/scenarios/workers by stable
 * ids. It never feeds outcomes, never throws on a bad trace backend, and only
 * passes allowlisted ids (no payloads, prompts, commands, paths or media).
 */

export const CORRELATION_LABEL = 'diagnostic: not evidence of a result';

/** Minimal ledger reference; event payloads are deliberately not accepted. */
export interface LedgerEventRef {
  id: string;
  kind: string;
  timestamp: string;
  runId?: string;
  attemptId?: string;
  scenarioId?: string;
  workerId?: string;
}

export interface TraceBackendConfig {
  /** Langfuse UI base URL; absent means ids only, no links. */
  baseUrl?: string;
  projectId?: string;
  /** Caller-observed reachability; false degrades to unavailable. */
  reachable?: boolean;
}

export interface TraceLink {
  traceId: string;
  url?: string;
}

export interface CorrelationEntry {
  runId: string;
  attemptId: string | null;
  scenarioId: string;
  shard: string;
  role: string;
  workerId: string | null;
  ledgerEvents: Array<{ id: string; kind: string; timestamp: string }>;
  trace: TraceLink | null;
}

export interface CorrelationBlock {
  authoritative: false;
  label: typeof CORRELATION_LABEL;
  /** `unavailable` when the trace backend is missing, unreachable or an id is malformed. */
  status: 'ok' | 'unavailable';
  entries: CorrelationEntry[];
  unavailableReason: string | null;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TRACE_ID = /^[0-9a-f]{32}$/i;
const MAX_EVENTS_PER_ENTRY = 50;

function safe(v: string | null | undefined): string | null {
  return v && SAFE_ID.test(v) ? v : null;
}

export function buildCorrelation(input: {
  runId: string;
  scenarioId: string;
  partitions: RolePartition[];
  ledgerEvents?: LedgerEventRef[];
  traceBackend?: TraceBackendConfig;
}): CorrelationBlock {
  const mine = input.partitions.filter((p) => p.runId === input.runId && p.scenarioId === input.scenarioId);
  const cfg = input.traceBackend;
  let reason: string | null = null;
  const hasTraces = mine.some((p) => p.traceId);
  if (hasTraces && !cfg) reason = 'trace backend not configured';
  else if (cfg && cfg.reachable === false) reason = 'trace backend unreachable';
  const canLink = !!cfg && cfg.reachable !== false && !!cfg.baseUrl && !!cfg.projectId;

  const entries: CorrelationEntry[] = mine.map((p) => {
    const attemptId = safe(p.attemptId);
    const workerId = safe(p.workerId);
    const events = (input.ledgerEvents ?? [])
      .filter((e) => safe(e.id) && e.runId === input.runId
        && (e.scenarioId === undefined || e.scenarioId === input.scenarioId)
        && (attemptId ? e.attemptId === attemptId : e.attemptId === undefined)
        && (e.workerId === undefined || e.workerId === workerId))
      .slice(0, MAX_EVENTS_PER_ENTRY)
      .map((e) => ({
        id: e.id,
        kind: redactError(e.kind) ?? '',
        timestamp: Number.isFinite(Date.parse(e.timestamp)) ? e.timestamp : '',
      }));
    let trace: TraceLink | null = null;
    if (p.traceId) {
      if (!TRACE_ID.test(p.traceId)) {
        reason = reason ?? 'malformed trace id';
      } else if (reason === null) {
        trace = { traceId: p.traceId.toLowerCase() };
        if (canLink) {
          try {
            trace.url = createLangfuseTraceUrl({ baseUrl: cfg!.baseUrl!, projectId: cfg!.projectId!, traceId: p.traceId });
          } catch {
            reason = 'trace link configuration invalid';
            trace = null;
          }
        }
      }
    }
    return { runId: input.runId, attemptId, scenarioId: input.scenarioId, shard: p.shard, role: p.role, workerId, ledgerEvents: events, trace };
  });

  if (reason !== null) {
    // Degrade: keep ledger refs, drop every trace link.
    for (const e of entries) e.trace = null;
  }
  return { authoritative: false, label: CORRELATION_LABEL, status: reason === null ? 'ok' : 'unavailable', entries, unavailableReason: reason };
}
