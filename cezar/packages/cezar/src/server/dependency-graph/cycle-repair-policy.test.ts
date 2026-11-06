import { describe, expect, it } from 'vitest';
import { type DependencyGraphEdge, type DependencyGraphSnapshot, dependencyNodeId } from '@open-mercato/cezar-contract';
import { planCycleRepairs } from './repair-planner.ts';
import { validateCycleRepair } from './cycle-repair-policy.ts';

const at = '2026-10-30T12:00:00.000Z';
const repository = 'acme/work';
const a = dependencyNodeId('issue', repository, 1);
const b = dependencyNodeId('issue', repository, 2);
const unrelated = dependencyNodeId('issue', repository, 3);
const ab = '00000000-0000-4000-8000-000000000001';
const ba = '00000000-0000-4000-8000-000000000002';

function edge(id: string, from: string, to: string, origin: DependencyGraphEdge['provenance']['origin'] = 'github-native'): DependencyGraphEdge {
  return { id, kind: 'BLOCKS', from, to, direction: 'from-to', provenance: { origin, authority: origin === 'model' ? 'proposed' : 'verified', confidence: 1, recordedAt: at, evidence: [] }, createdAt: at, updatedAt: at };
}

function snapshot(): DependencyGraphSnapshot {
  return { schemaVersion: 1, repository, revision: 7, createdAt: at, source: { status: 'fresh', lastSuccessfulSyncAt: at }, nodes: [
    { kind: 'issue', id: a, repository, number: 1, title: 'A', state: 'open', labels: [], url: 'https://github.com/acme/work/issues/1', revision: at, updatedAt: at },
    { kind: 'issue', id: b, repository, number: 2, title: 'B', state: 'open', labels: [], url: 'https://github.com/acme/work/issues/2', revision: at, updatedAt: at },
    { kind: 'issue', id: unrelated, repository, number: 3, title: 'C', state: 'open', labels: [], url: 'https://github.com/acme/work/issues/3', revision: at, updatedAt: at },
  ], edges: [edge(ab, a, b), edge(ba, b, a)], decisions: [] };
}

describe('cycle repair policy', () => {
  it('permits a reviewed verified-edge removal only when it breaks the target SCC', () => {
    const graph = snapshot();
    const candidate = planCycleRepairs(graph).candidates[0]!;
    const result = validateCycleRepair(graph, { expectedGraphRevision: graph.revision, candidateId: candidate.id, removeEdgeIds: [ab], rationale: 'Remove a verified edge after confirming its dependency is obsolete.' });
    expect(result.simulation.cyclesAfter).toEqual([]);
    expect(result.simulation.persisted).toBe(false);
  });

  it('rejects stale proposals, non-cycle edges, and patches that leave the cycle', () => {
    const graph = snapshot();
    const candidate = planCycleRepairs(graph).candidates[0]!;
    const request = { expectedGraphRevision: graph.revision, candidateId: candidate.id, removeEdgeIds: [ab], rationale: 'Remove a verified edge after confirming its dependency is obsolete.' };
    expect(() => validateCycleRepair({ ...graph, source: { status: 'stale' } }, request)).toThrow(/fresh/);
    expect(() => validateCycleRepair(graph, { ...request, expectedGraphRevision: 6 })).toThrow(/revision conflict/);
    expect(() => validateCycleRepair(graph, { ...request, removeEdgeIds: [] })).toThrow(/does not remove the target cycle/);
    expect(() => validateCycleRepair(graph, { ...request, removeEdgeIds: ['not-an-edge'] })).toThrow(/not part/);
  });

  it('rejects model-origin blocker edges even when they are part of a candidate', () => {
    const graph = snapshot();
    graph.edges = [edge(ab, a, b, 'human'), edge(ba, b, a)];
    const candidate = planCycleRepairs(graph).candidates[0]!;
    expect(() => validateCycleRepair(graph, { expectedGraphRevision: graph.revision, candidateId: candidate.id, removeEdgeIds: [ab], rationale: 'Do not trust model-origin dependency evidence.' })).toThrow(/verified GitHub blocker/);
  });
});
