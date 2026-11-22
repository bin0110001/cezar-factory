import { describe, expect, it } from 'vitest';
import {
  evaluateReleaseCandidatePromotionGate,
  MAX_CANDIDATE_SNAPSHOT_AGE_MS,
} from './workflow-gates.ts';

const now = new Date('2026-11-22T12:00:00.000Z');
const sha = (char: string) => char.repeat(40);

function candidate(over: Record<string, unknown> = {}) {
  return {
    id: 'candidate-1',
    state: 'promoting',
    revision: 4,
    devSha: sha('a'),
    baseStableSha: sha('b'),
    candidateSha: sha('c'),
    configHash: `sha256:${'d'.repeat(64)}`,
    createdAt: '2026-11-22T10:00:00.000Z',
    updatedAt: '2026-11-22T11:59:00.000Z',
    lease: { owner: 'worker-1', expiresAt: '2026-11-22T12:30:00.000Z', stale: false },
    tests: { status: 'passed', shards: { total: 4, passed: 4, failed: 0 }, assetVersion: 'v1' },
    devDrift: { commitsAhead: 0, newestDevSha: sha('a') },
    blockers: [],
    repairObligations: [],
    receipts: [],
    pending: { count: 0, coalescedReason: null, triggers: [] },
    nextScheduledAttempt: null,
    links: { pullRequests: [], issues: [] },
    warnings: [],
    checkMatrix: [],
    ...over,
  };
}

function request(over: Record<string, unknown> = {}) {
  return {
    projectId: 'cezar-factory',
    inputs: { candidateId: 'candidate-1', candidateSha: sha('c'), candidateRevision: 4, ...over },
  };
}

function snapshot(candidateValue = candidate(), snapshotAt = '2026-11-22T11:59:00.000Z') {
  return { snapshotAt, projects: { 'cezar-factory': { candidates: [candidateValue] } } };
}

describe('release candidate promotion policy gate', () => {
  it('passes only the exact current candidate after the host has recorded approval', () => {
    const result = evaluateReleaseCandidatePromotionGate(request(), snapshot(), now);
    expect(result.outcome).toBe('passed');
    expect(result.outputs).toMatchObject({
      status: 'passed', candidateId: 'candidate-1', candidateSha: sha('c'), candidateRevision: 4,
      snapshotAt: '2026-11-22T11:59:00.000Z', evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('does not treat a human resume as approval when the host candidate is still awaiting approval', () => {
    const result = evaluateReleaseCandidatePromotionGate(request(), snapshot(candidate({ state: 'awaiting-approval' })), now);
    expect(result).toMatchObject({ outcome: 'needs_input', outputs: { reasonCode: 'host-approval-not-recorded' } });
  });

  it('rejects a changed candidate revision or SHA', () => {
    expect(evaluateReleaseCandidatePromotionGate(request({ candidateRevision: 5 }), snapshot(), now).outcome).toBe('blocked');
    expect(evaluateReleaseCandidatePromotionGate(request({ candidateSha: sha('e') }), snapshot(), now).outcome).toBe('blocked');
  });

  it('fails closed for stale, incomplete, or blocked evidence', () => {
    const stale = snapshot(candidate(), new Date(now.getTime() - MAX_CANDIDATE_SNAPSHOT_AGE_MS - 1).toISOString());
    const incomplete = snapshot(candidate({
      tests: { status: 'unknown', shards: { total: 4, passed: 3, failed: 0 }, assetVersion: 'v1' },
    }));
    const blocked = snapshot(candidate({ blockers: [{ code: 'required-audit', message: 'required audit unavailable' }] }));
    const blockedAudit = snapshot(candidate({
      checkMatrix: [{ category: 'ai-audit', status: 'unknown', blocking: true, newFindings: 0, knownFindings: 0,
        provider: null, feed: 'unavailable', scope: null, sbomDigest: null, activeWaivers: 0 }],
    }));
    expect(evaluateReleaseCandidatePromotionGate(request(), stale, now).outcome).toBe('unknown');
    expect(evaluateReleaseCandidatePromotionGate(request(), incomplete, now).outcome).toBe('unknown');
    expect(evaluateReleaseCandidatePromotionGate(request(), blocked, now).outcome).toBe('blocked');
    expect(evaluateReleaseCandidatePromotionGate(request(), blockedAudit, now).outcome).toBe('blocked');
  });
});
