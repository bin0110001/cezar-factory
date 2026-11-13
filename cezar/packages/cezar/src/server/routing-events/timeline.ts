import type { RoutingEvent } from './event.ts';
import { redactEvent } from './redact.ts';

export type TimelineEntry = {
  sequence: number;
  timestamp: string;
  state: RoutingEvent['state'];
  attempt: number;
  eventId?: string;
  attemptId?: string;
  traceId?: string;
  model?: string;
  tier?: string;
  reason?: string;
};
export type TimelineAttempt = { attempt: number; attemptId?: string; entries: TimelineEntry[] };
export type DecisionExplanation = {
  kind: 'routed' | 'delayed' | 'unknown';
  summary: string;
  model?: string;
  tier?: string;
  reason?: string;
  fallback?: boolean;
  quota?: { limit?: number; used?: number; remaining?: number; ratio?: number; resetAt?: string };
  sequence?: number;
};
export type TaskTimeline = { runId?: string; truncated: boolean; entries: TimelineEntry[]; attempts: TimelineAttempt[]; explanation: DecisionExplanation };

export const DEFAULT_TIMELINE_LIMIT = 500;

/**
 * Pure projection over persisted events for one task. Order is the persisted sequence (never timestamps);
 * duplicate events are dropped; events are re-redacted at this read boundary. Missing evidence stays unknown.
 */
export function buildTaskTimeline(input: readonly unknown[], opts: { runId?: string; limit?: number } = {}): TaskTimeline {
  const limit = opts.limit ?? DEFAULT_TIMELINE_LIMIT;
  const safe = input.flatMap((raw) => {
    const seq = (raw as { sequence?: unknown } | null)?.sequence;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) return [];
    const r = redactEvent(raw);
    if (typeof r.timestamp !== 'string' || typeof r.state !== 'string' || r.state === 'invalid') return [];
    const e = { schemaVersion: 1, attempt: 1, ...r, sequence: seq } as unknown as RoutingEvent;
    return !opts.runId || e.runId === opts.runId ? [e] : [];
  }).sort((a, b) => a.sequence - b.sequence);
  const seen = new Set<string>();
  const unique = safe.filter((e) => {
    const key = e.eventId ?? `sequence:${e.sequence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const truncated = unique.length > limit;
  const kept = truncated ? unique.slice(-limit) : unique;
  const entries: TimelineEntry[] = kept.map((e) => ({
    sequence: e.sequence, timestamp: e.timestamp, state: e.state, attempt: e.attempt,
    ...(e.eventId && { eventId: e.eventId }), ...(e.attemptId && { attemptId: e.attemptId }), ...(e.traceId && { traceId: e.traceId }),
    ...(e.selected?.model && { model: e.selected.model }), ...(e.selected?.tier && { tier: e.selected.tier }),
    ...((e.decisionReason ?? e.deferralReason) && { reason: (e.decisionReason ?? e.deferralReason)! }),
  }));
  const byAttempt = new Map<number, TimelineAttempt>();
  for (const entry of entries) {
    const a = byAttempt.get(entry.attempt) ?? { attempt: entry.attempt, ...(entry.attemptId && { attemptId: entry.attemptId }), entries: [] };
    a.entries.push(entry);
    byAttempt.set(entry.attempt, a);
  }
  const attempts = [...byAttempt.values()].sort((a, b) => a.attempt - b.attempt);
  return { ...(opts.runId && { runId: opts.runId }), truncated, entries, attempts, explanation: explainDecision(kept) };
}

/** Explains the latest recorded routing/deferral decision; never infers a reason that was not recorded. */
export function explainDecision(events: readonly RoutingEvent[]): DecisionExplanation {
  const last = [...events].reverse().find((e) => e.state === 'routed' || e.state === 'capacity-blocked' || e.state === 'rate-limited');
  if (!last) return { kind: 'unknown', summary: 'No routing or delay decision has been recorded for this task.' };
  const quota = last.quotaSnapshot && Object.keys(last.quotaSnapshot).length ? last.quotaSnapshot : undefined;
  const routed = last.state === 'routed';
  const reason = routed ? last.decisionReason : (last.deferralReason ?? last.decisionReason);
  const model = last.selected?.model;
  const head = routed ? `Routed to ${model ?? 'an unrecorded model'}${last.selected?.tier ? ` (tier ${last.selected.tier})` : ''}` : `Delayed (${last.state})`;
  const parts = [head, `reason: ${reason ?? 'not recorded'}`];
  if (last.fallback) parts.push('fallback route');
  if (quota) parts.push(`quota: ${Object.entries(quota).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  else parts.push('quota snapshot unavailable');
  return {
    kind: routed ? 'routed' : 'delayed', summary: parts.join('; '),
    ...(model && { model }), ...(last.selected?.tier && { tier: last.selected.tier }), ...(reason && { reason }),
    ...(last.fallback !== undefined && { fallback: last.fallback }), ...(quota && { quota }), sequence: last.sequence,
  };
}
