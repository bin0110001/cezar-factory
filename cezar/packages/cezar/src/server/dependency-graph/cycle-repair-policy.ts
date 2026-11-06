import type { DependencyCycleRepairApply, DependencyGraphSnapshot } from '@open-mercato/cezar-contract';
import { isVerifiedBlockingEdge } from '@open-mercato/cezar-contract';
import { blockingCycles, simulateDependencyGraph } from './algorithms.ts';
import { planCycleRepairs } from './repair-planner.ts';

function cycleKey(nodeIds: string[]): string {
  return [...nodeIds].sort().join('\0');
}

/** Validate an operator-approved patch against one fresh snapshot and prove its bounded effects. */
export function validateCycleRepair(snapshot: DependencyGraphSnapshot, input: DependencyCycleRepairApply) {
  if (snapshot.source.status !== 'fresh') throw new Error('cycle repair requires a fresh GitHub graph');
  if (snapshot.revision !== input.expectedGraphRevision) throw new Error(`dependency graph revision conflict: expected ${input.expectedGraphRevision}, found ${snapshot.revision}`);

  const candidate = planCycleRepairs(snapshot, 50).candidates.find((item) => item.id === input.candidateId);
  if (!candidate) throw new Error('cycle repair candidate is stale or no longer exists');
  if (!candidate.requiresHumanReview) throw new Error('cycle repair requires explicit human review');

  const cycleNodes = new Set(candidate.cycleNodeIds);
  const evidenceIds = new Set(candidate.evidence.map((item) => item.edgeId));
  const currentEdges = new Map(snapshot.edges.map((edge) => [edge.id, edge]));
  for (const id of input.removeEdgeIds) {
    const edge = currentEdges.get(id);
    if (!edge || !evidenceIds.has(id)) throw new Error(`edge is not part of the current repair candidate: ${id}`);
    if (!isVerifiedBlockingEdge(edge) || edge.provenance.origin !== 'github-native') throw new Error(`only verified GitHub blocker edges can be repaired: ${id}`);
    if (!cycleNodes.has(edge.from) || !cycleNodes.has(edge.to)) throw new Error(`edge is outside the target cycle: ${id}`);
  }

  const simulation = simulateDependencyGraph(snapshot, {
    expectedRevision: input.expectedGraphRevision,
    removeEdgeIds: input.removeEdgeIds,
  });
  const afterCycles = new Set(simulation.cyclesAfter.map(cycleKey));
  if (afterCycles.has(cycleKey(candidate.cycleNodeIds))) throw new Error('proposed repair does not remove the target cycle');
  const beforeCycles = new Set(simulation.cyclesBefore.map(cycleKey));
  if (simulation.summary.changes.cycles > 0 || simulation.summary.addedCycles.length > 0) throw new Error('proposed repair introduces a blocking cycle');

  const affected = new Set(candidate.affectedIssueIds);
  const unrelatedReadinessChange = simulation.summary.changedReadiness.find((change) => !affected.has(change.nodeId));
  if (unrelatedReadinessChange) throw new Error(`proposed repair changes unrelated readiness: ${unrelatedReadinessChange.nodeId}`);
  if (!beforeCycles.has(cycleKey(candidate.cycleNodeIds))) throw new Error('target cycle is no longer present');

  return { candidate, simulation };
}

/** The API receives edge IDs only; pair direction is derived from the verified snapshot. */
export function removedCycleEdges(snapshot: DependencyGraphSnapshot, input: DependencyCycleRepairApply) {
  const byId = new Map(snapshot.edges.map((edge) => [edge.id, edge]));
  return input.removeEdgeIds.map((id) => {
    const edge = byId.get(id);
    if (!edge) throw new Error(`edge not found: ${id}`);
    return edge;
  });
}
