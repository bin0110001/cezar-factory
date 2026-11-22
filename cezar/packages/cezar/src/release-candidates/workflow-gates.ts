import { createHash } from 'node:crypto';
import { buildReleaseCandidates, readSnapshot, snapshotPath } from './read-model.ts';

export const RELEASE_CANDIDATE_PROMOTION_POLICY = 'release.candidate.promotion-ready';
export const MAX_CANDIDATE_SNAPSHOT_AGE_MS = 10 * 60 * 1000;

export interface ReleaseCandidatePromotionGateRequest {
  projectId?: string;
  inputs: Record<string, unknown>;
}

export interface ReleaseCandidatePromotionGateResult {
  outcome: 'passed' | 'blocked' | 'needs_input' | 'unknown';
  outputs: Record<string, unknown>;
}

const denied = (outcome: ReleaseCandidatePromotionGateResult['outcome'], reasonCode: string): ReleaseCandidatePromotionGateResult => ({
  outcome,
  outputs: { status: outcome, reasonCode },
});

/**
 * Read-only handoff gate for a candidate that the host release engine has
 * already advanced into `promoting`. The engine owns candidate state and the
 * human approval record; this check only confirms that the approval still
 * names the same current artifact and that its required evidence is intact.
 */
export function evaluateReleaseCandidatePromotionGate(
  request: ReleaseCandidatePromotionGateRequest,
  snapshot: unknown,
  now: Date,
  maxSnapshotAgeMs = MAX_CANDIDATE_SNAPSHOT_AGE_MS,
): ReleaseCandidatePromotionGateResult {
  const projectId = request.projectId;
  const { candidateId, candidateSha, candidateRevision } = request.inputs;
  if (!projectId || typeof candidateId !== 'string' || !candidateId
      || typeof candidateSha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(candidateSha)
      || typeof candidateRevision !== 'number' || !Number.isInteger(candidateRevision) || candidateRevision < 0) {
    return denied('unknown', 'candidate-identity-missing-or-invalid');
  }

  const model = buildReleaseCandidates(snapshot, now);
  if (!model.available || !model.snapshotAt) return denied('unknown', 'candidate-snapshot-unavailable');
  const snapshotAge = now.getTime() - Date.parse(model.snapshotAt);
  if (!Number.isFinite(snapshotAge) || snapshotAge < 0 || snapshotAge > maxSnapshotAgeMs) {
    return denied('unknown', 'candidate-snapshot-stale');
  }

  const project = model.projects.find((entry) => entry.projectId === projectId);
  if (!project) return denied('unknown', 'candidate-project-unavailable');
  if (project.warnings.length > 0) return denied('unknown', 'candidate-project-integrity-warning');
  const candidate = project.active;
  if (!candidate) return denied('blocked', 'candidate-not-active');
  if (candidate.id !== candidateId || candidate.candidateSha?.toLowerCase() !== candidateSha.toLowerCase()
      || candidate.revision !== candidateRevision) {
    return denied('blocked', 'candidate-revision-mismatch');
  }
  if (candidate.warnings.length > 0) return denied('unknown', 'candidate-integrity-warning');
  if (candidate.state !== 'promoting') return denied('needs_input', 'host-approval-not-recorded');
  if (candidate.lease.stale) return denied('unknown', 'candidate-lease-stale');
  if (candidate.tests.status !== 'passed') return denied('unknown', 'candidate-tests-not-currently-passing');
  if (candidate.blockers.length > 0) return denied('blocked', 'candidate-has-release-blockers');
  if (candidate.checkMatrix.some((check) => check.blocking && !['pass', 'warn', 'not-applicable'].includes(check.status))) {
    return denied('blocked', 'candidate-has-blocking-check-results');
  }

  const evidence = {
    projectId,
    candidateId: candidate.id,
    candidateSha: candidate.candidateSha,
    candidateRevision: candidate.revision,
    state: candidate.state,
    snapshotAt: model.snapshotAt,
    tests: candidate.tests,
    checkMatrix: candidate.checkMatrix,
  };
  return {
    outcome: 'passed',
    outputs: {
      status: 'passed',
      candidateId: candidate.id,
      candidateSha: candidate.candidateSha,
      candidateRevision: candidate.revision,
      snapshotAt: model.snapshotAt,
      evidenceDigest: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),
    },
  };
}

export const releaseCandidatePromotionGate = {
  policy: RELEASE_CANDIDATE_PROMOTION_POLICY,
  evaluate: (request: ReleaseCandidatePromotionGateRequest) => evaluateReleaseCandidatePromotionGate(
    request,
    readSnapshot(snapshotPath()),
    new Date(),
  ),
};
