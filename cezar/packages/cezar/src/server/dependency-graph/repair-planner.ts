import { createHash } from 'node:crypto';
import type { DependencyGraphSnapshot } from '@open-mercato/cezar-contract';
import { blockingCycles, downstreamImpact } from './algorithms.ts';

/** Review-only cycle plan. A valid verified blocker is never weakened by this planner. */
export function planCycleRepairs(snapshot: DependencyGraphSnapshot, limit = 20) {
  const boundedLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const cycles = blockingCycles(snapshot);
  const candidates = cycles.slice(0, boundedLimit).map((nodeIds) => {
    const cycleEdges = snapshot.edges.filter((edge) => edge.kind === 'BLOCKS' && edge.provenance.authority === 'verified'
      && edge.provenance.origin !== 'model' && nodeIds.includes(edge.from) && nodeIds.includes(edge.to));
    const affectedIssueIds = [...new Set(nodeIds.flatMap((id) => downstreamImpact(snapshot, id, 200).nodeIds))].sort();
    const fingerprint = createHash('sha256').update(`${snapshot.repository}\0${nodeIds.join('\0')}`).digest('hex').slice(0, 32);
    const identity = `${snapshot.revision}\0${fingerprint}`;
    return {
      id: createHash('sha256').update(identity).digest('hex').slice(0, 24),
      fingerprint,
      kind: 'contract-first-decomposition' as const,
      repository: snapshot.repository,
      graphRevision: snapshot.revision,
      sourceStatus: snapshot.source.status,
      requiresHumanReview: true as const,
      cycleNodeIds: nodeIds,
      evidence: cycleEdges.map((edge) => ({ edgeId: edge.id, from: edge.from, to: edge.to, sourceUrl: edge.provenance.sourceUrl })).sort((a, b) => a.edgeId.localeCompare(b.edgeId)),
      affectedIssueIds,
      preconditions: { graphRevision: snapshot.revision, verifiedEdgeIds: cycleEdges.map((edge) => edge.id).sort() },
      proposal: 'Review whether the cycle hides a shared contract decision. If so, extract a contract-first issue, make both implementation issues depend on it, and record the decision that resolves the ordering conflict.',
      patch: { addEdges: [], removeEdgeIds: [] },
      simulation: { cyclesBefore: cycles.length, cyclesAfter: cycles.length, changedReadiness: [] as string[], persisted: false as const },
      rollback: { restoreEdges: [] as string[], removeEdges: [] as string[], required: false as const },
      rationale: 'The cycle contains verified source relationships. No edge is safe to remove or rewrite without evidence and human approval.',
    };
  });
  return { revision: snapshot.revision, source: snapshot.source, candidates, totalCycles: cycles.length, truncated: cycles.length > boundedLimit };
}
