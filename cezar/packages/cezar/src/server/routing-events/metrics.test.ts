import { describe, expect, it } from 'vitest';
import type { RoutingEvent } from './event.ts';
import { computeRoutingMetrics } from './metrics.ts';

const event = (sequence: number, state: RoutingEvent['state'], extra: Partial<RoutingEvent> = {}): RoutingEvent => ({
  schemaVersion: 1, timestamp: `2026-01-01T00:00:${String(sequence).padStart(2, '0')}Z`, sequence, attempt: 1, state, runId: 'r1', attemptId: 'a1', ...extra,
});

describe('routing metrics projection', () => {
  it('represents empty history as unknown with zero samples', () => {
    expect(computeRoutingMetrics([])).toEqual({
      utilization: { value: null, samples: 0 }, blockedDurationMs: { value: null, samples: 0 },
      fallbackFrequency: { value: null, samples: 0 }, successByTier: {}, forecastConfidence: { value: null, samples: 0 },
    });
  });

  it('computes observed quota, blocked duration, fallback, outcomes and confidence', () => {
    const history = [
      event(1, 'capacity-blocked', { runId: 'r1', attemptId: 'a2' }),
      event(3, 'routed', { runId: 'r1', attemptId: 'a2', fallback: true, selected: { tier: 'economy' }, quotaSnapshot: { limit: 100, used: 50 }, forecastConfidence: 0.8 }),
      event(4, 'completed', { runId: 'r1', attemptId: 'a2', selected: { tier: 'economy' } }),
      event(5, 'routed', { runId: 'r2', attemptId: 'a1', fallback: false, selected: { tier: 'premium' }, quotaSnapshot: { ratio: 0.25 }, forecastConfidence: 1 }),
      event(6, 'failed', { runId: 'r2', attemptId: 'a1', selected: { tier: 'premium' } }),
    ];
    expect(computeRoutingMetrics(history)).toEqual({
      utilization: { value: 0.375, samples: 2 }, blockedDurationMs: { value: 2000, samples: 1 },
      fallbackFrequency: { value: 0.5, samples: 2 },
      successByTier: {
        economy: { successes: 1, failures: 0, rate: 1, samples: 1 },
        premium: { successes: 0, failures: 1, rate: 0, samples: 1 },
      }, forecastConfidence: { value: 0.9, samples: 2 },
    });
  });

  it('is stable for reordered input, deduplicates event IDs, and omits unsupported estimates', () => {
    const history = [
      event(2, 'routed', { eventId: 'decision-1', fallback: true }),
      event(1, 'capacity-blocked'),
      event(3, 'capacity-blocked', { runId: 'r2', attemptId: 'a2' }),
    ];
    const duplicate = { ...history[0]!, sequence: 4 };
    expect(computeRoutingMetrics([...history, duplicate])).toEqual(computeRoutingMetrics([duplicate, ...history]));
    const result = computeRoutingMetrics(history);
    expect(result.blockedDurationMs).toEqual({ value: 1000, samples: 1 });
    expect(result.forecastConfidence).toEqual({ value: null, samples: 0 });
    expect(result.successByTier).toEqual({});
  });
});
