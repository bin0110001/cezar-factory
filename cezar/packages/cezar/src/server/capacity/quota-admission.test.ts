import { describe, expect, it } from 'vitest';
import {
  QuotaAdmissionController,
  evaluateCandidateAdmission,
  evaluateCandidatesAdmission,
  evaluateCapacityProfile,
  evaluateCapacityWindow,
  admissionRetryDelaySeconds,
  effectiveAdmissionPriority,
  type AdmissionContext,
  type CapacityCandidate,
  type SubscriptionCapacityProfile,
} from './quota-admission.ts';

const now = Date.parse('2026-11-22T12:00:00.000Z');
const profile: SubscriptionCapacityProfile = {
  id: 'claude-main', provider: 'claude', enabled: true, maxConcurrency: 2,
  allowedModelIds: ['claude/opus'],
  windows: [{ name: '5h', limit: 100, remaining: 40, resetAt: '2026-11-22T15:00:00.000Z', observedAt: '2026-11-22T11:59:00.000Z' }],
};
const candidate: CapacityCandidate = {
  profileId: 'claude-main', provider: 'claude', modelId: 'claude/opus', estimatedCost: { '5h': 10 },
};
const context = (overrides: Partial<AdmissionContext> = {}): AdmissionContext => ({
  now, activeByProfile: {}, reservedByProfileAndWindow: {}, unknownMode: 'conservative', ...overrides,
});

describe('quota admission policy', () => {
  it('bounds retries, honors retry-after, and ages older work', () => {
    expect(admissionRetryDelaySeconds(3, 120, 0.5)).toBe(132);
    expect(admissionRetryDelaySeconds(20, undefined, 0.99)).toBe(3600);
    expect(effectiveAdmissionPriority(1, now - 7_200_000, now, 0.5)).toBe(2);
  });

  it('uses the most constrained independent window', () => {
    expect(evaluateCapacityProfile({ ...profile, windows: [
      profile.windows[0]!, { ...profile.windows[0]!, name: 'weekly', remaining: 0 },
    ] }, now)).toBe('exhausted');
  });

  it('does not admit a known-exhausted candidate', () => {
    const exhausted = { ...profile, windows: [{ ...profile.windows[0]!, remaining: 0 }] };
    expect(evaluateCandidateAdmission(exhausted, candidate, context())).toMatchObject({
      status: 'deferred', reason: 'capacity-exhausted:5h',
    });
  });

  it('checks every profile window even when routing did not supply a cost for it', () => {
    const exhaustedWeekly = { ...profile, windows: [
      profile.windows[0]!, { ...profile.windows[0]!, name: 'weekly', remaining: 0 },
    ] };
    expect(evaluateCandidateAdmission(exhaustedWeekly, candidate, context())).toMatchObject({
      status: 'deferred', reason: 'capacity-exhausted:weekly',
    });
  });

  it('tries an explicitly ordered fallback after the primary is exhausted', () => {
    const fallback: SubscriptionCapacityProfile = { ...profile, id: 'claude-work', maxConcurrency: 1 };
    const primary = { ...profile, windows: [{ ...profile.windows[0]!, remaining: 0 }] };
    const result = evaluateCandidatesAdmission(new Map([[primary.id, primary], [fallback.id, fallback]]), [
      candidate, { ...candidate, profileId: fallback.id },
    ], context());
    expect(result).toMatchObject({ candidateIndex: 1, candidate: { profileId: 'claude-work' }, result: { status: 'admitted' } });
    expect(result.rejections).toEqual([{ candidateIndex: 0, status: 'deferred', reason: 'capacity-exhausted:5h' }]);
  });

  it('accounts for concurrent reservations and profile concurrency', () => {
    expect(evaluateCandidateAdmission(profile, candidate, context({
      reservedByProfileAndWindow: { 'claude-main': { '5h': 35 } },
    })).status).toBe('deferred');
    const concurrency = evaluateCandidateAdmission(profile, candidate, context({
      activeByProfile: { 'claude-main': 2 },
    }));
    expect(concurrency.status === 'deferred' ? concurrency.reason : '').toBe('concurrency-limit');
  });

  it('defers unknown capacity in conservative mode and allows a bounded probe in optimistic mode', () => {
    const unknown = { ...profile, windows: [{ name: '5h' }] };
    expect(evaluateCandidateAdmission(unknown, candidate, context()).status).toBe('deferred');
    expect(evaluateCandidateAdmission(unknown, candidate, context({ unknownMode: 'optimistic' })).status)
      .toBe('admitted');
    const limited = evaluateCandidateAdmission(unknown, candidate, context({
      unknownMode: 'optimistic', unknownProbeByProfile: { 'claude-main': 1 },
    }));
    expect(limited.status === 'deferred' ? limited.reason : '').toBe('unknown-probe-limit:5h');
  });

  it('treats an observed window as reset only after clock-drift tolerance', () => {
    const window = { name: '5h', limit: 100, remaining: 0, resetAt: new Date(now - 120_001).toISOString() };
    expect(evaluateCapacityWindow(window, now)).toBe('available');
  });

  it('reserves idempotently, accounts for concurrent jobs, and reclaims expired leases', () => {
    const controller = new QuotaAdmissionController({ leaseSeconds: 10, random: () => 0 });
    const costly = { ...candidate, estimatedCost: { '5h': 40 } };
    const first = controller.admit('run-1', [costly], new Map([[profile.id, profile]]), { now });
    expect(first.status).toBe('admitted');
    const duplicate = controller.admit('run-1', [costly], new Map([[profile.id, profile]]), { now });
    expect(duplicate.status === 'admitted' && duplicate.duplicate).toBe(true);
    expect(controller.admit('run-2', [costly], new Map([[profile.id, profile]]), { now }).status).toBe('deferred');
    expect(controller.snapshot(now + 10_001).leases).toHaveLength(0);
    expect(controller.reevaluate(new Map([[profile.id, profile]]), { now: now + 31_000 })[0]?.result.status)
      .toBe('admitted');
  });

  it('uses the earliest known reset across exhausted fallback candidates', () => {
    const first = { ...profile, id: 'first', windows: [{ ...profile.windows[0]!, remaining: 0, resetAt: new Date(now + 3_600_000).toISOString() }] };
    const second = { ...profile, id: 'second', windows: [{ ...profile.windows[0]!, remaining: 0, resetAt: new Date(now + 7_200_000).toISOString() }] };
    const controller = new QuotaAdmissionController({ random: () => 0 });
    const result = controller.admit('fallback', [
      { ...candidate, profileId: first.id }, { ...candidate, profileId: second.id },
    ], new Map([[first.id, first], [second.id, second]]), { now });
    expect(result.status).toBe('deferred');
    if (result.status === 'deferred') expect(result.retryAt).toBe(now + 3_600_000 + 120_000);
  });

  it('persists deferrals, cooldowns, and lease recovery through a snapshot', () => {
    const controller = new QuotaAdmissionController({ random: () => 0 });
    const unknown = { ...profile, windows: [{ name: '5h' }] };
    controller.admit('deferred', [candidate], new Map([[profile.id, unknown]]), {
      now, unknownMode: 'conservative',
    });
    controller.reportRateLimit('missing', 'claude', '5h', 90, now);
    const restored = new QuotaAdmissionController({ random: () => 0 }, controller.snapshot(now));
    expect(restored.snapshot(now).deferred.map((job) => job.jobId)).toContain('deferred');
    expect(restored.admit('next', [candidate], new Map([[profile.id, unknown]]), { now }).status).toBe('deferred');
  });

  it('transfers a scheduler receipt reservation to the created run', () => {
    const controller = new QuotaAdmissionController({ random: () => 0 });
    expect(controller.admit('receipt-1', [candidate], new Map([[profile.id, profile]]), { now }).status)
      .toBe('admitted');
    expect(controller.rekeyLease('receipt-1', 'run-1')).toBe(true);
    expect(controller.heartbeat('run-1', now + 1)).toBe(true);
    expect(controller.release('run-1')).toBe(true);
    expect(controller.snapshot(now + 2).leases).toHaveLength(0);
  });
});
