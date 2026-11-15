import { describe, expect, it } from 'vitest';
import type { RoutingEvent } from './event.ts';
import { buildTaskTimeline } from './timeline.ts';

const ev = (sequence: number, state: RoutingEvent['state'], extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1, timestamp: `2026-01-01T00:00:${String(60 - sequence).padStart(2, '0')}Z`, sequence, attempt: 1, state, runId: 'r1', attemptId: 'a1', ...extra,
});

describe('task timeline', () => {
  it('orders by sequence across retries, ignoring timestamps and arrival order', () => {
    const t = buildTaskTimeline([
      ev(4, 'running', { attempt: 2, attemptId: 'a2' }), ev(2, 'routed'), ev(1, 'queued'), ev(3, 'retried'), ev(5, 'completed', { attempt: 2, attemptId: 'a2' }),
    ]);
    expect(t.entries.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(t.attempts.map((a) => [a.attempt, a.entries.length])).toEqual([[1, 3], [2, 2]]);
  });

  it('drops duplicates, other runs and malformed events; truncates to the limit', () => {
    const t = buildTaskTimeline([ev(1, 'queued', { eventId: 'x' }), ev(2, 'queued', { eventId: 'x' }), ev(3, 'routed', { runId: 'other' }), { state: 'queued' }, ev(4, 'running'), ev(5, 'completed')], { runId: 'r1', limit: 2 });
    expect(t.entries.map((e) => e.sequence)).toEqual([4, 5]);
    expect(t.truncated).toBe(true);
  });

  it('explains route with reason and quota snapshot', () => {
    const t = buildTaskTimeline([ev(1, 'routed', { selected: { model: 'm1', tier: 'economy' }, decisionReason: 'cheapest-with-quota', quotaSnapshot: { limit: 100, used: 40 } })]);
    expect(t.explanation).toMatchObject({ kind: 'routed', model: 'm1', reason: 'cheapest-with-quota', quota: { limit: 100, used: 40 } });
    expect(t.explanation.summary).toContain('cheapest-with-quota');
  });

  it('explains delay and uses the latest decision', () => {
    const t = buildTaskTimeline([ev(1, 'routed', { selected: { model: 'm1' } }), ev(2, 'capacity-blocked', { deferralReason: 'quota-exhausted', quotaSnapshot: { remaining: 0, resetAt: '2026-01-01T01:00:00Z' } })]);
    expect(t.explanation).toMatchObject({ kind: 'delayed', reason: 'quota-exhausted', quota: { remaining: 0 } });
  });

  it('does not invent an explanation when evidence is absent', () => {
    expect(buildTaskTimeline([ev(1, 'queued')]).explanation.kind).toBe('unknown');
    const e = buildTaskTimeline([ev(1, 'routed')]).explanation;
    expect(e.reason).toBeUndefined();
    expect(e.summary).toContain('reason: not recorded');
    expect(e.summary).toContain('quota snapshot unavailable');
  });

  it('never returns prompts or credentials', () => {
    const t = buildTaskTimeline([ev(1, 'routed', { prompt: 'secret prompt', headers: { authorization: 'Bearer abc' }, decisionReason: 'used key sk-abcdefghijklmnopqrstuvwxyz123456' })]);
    const json = JSON.stringify(t);
    expect(json).not.toContain('secret prompt');
    expect(json).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(json).not.toContain('Bearer abc');
  });
});
