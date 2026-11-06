import { describe, expect, it } from 'vitest';
import { type DependencyGraphEdge, type DependencyGraphSnapshot, dependencyNodeId } from '@open-mercato/cezar-contract';
import { planCycleRepairs } from './repair-planner.ts';

const at = '2026-10-30T12:00:00.000Z';
const repository = 'acme/work';
const a = dependencyNodeId('issue', repository, 1);
const b = dependencyNodeId('issue', repository, 2);
function edge(from: string, to: string, id: string): DependencyGraphEdge {
  return { id, kind: 'BLOCKS', from, to, direction: 'from-to', provenance: { origin: 'github-native', authority: 'verified', confidence: 1, recordedAt: at, sourceUrl: `https://github.com/acme/work/issues/${from === a ? 1 : 2}`, evidence: [] }, createdAt: at, updatedAt: at };
}
function snapshot(): DependencyGraphSnapshot {
  return { schemaVersion: 1, repository, revision: 7, createdAt: at, source: { status: 'fresh', lastSuccessfulSyncAt: at }, nodes: [
    { kind: 'issue', id: a, repository, number: 1, title: 'Worker contract', state: 'open', labels: [], url: 'https://github.com/acme/work/issues/1', revision: at, updatedAt: at },
    { kind: 'issue', id: b, repository, number: 2, title: 'Adapter contract', state: 'open', labels: [], url: 'https://github.com/acme/work/issues/2', revision: at, updatedAt: at },
  ], edges: [edge(a, b, '00000000-0000-4000-8000-000000000001'), edge(b, a, '00000000-0000-4000-8000-000000000002')], decisions: [] };
}

describe('cycle repair planner', () => {
  it('proposes contract-first decomposition for a cycle without weakening verified edges', () => {
    const graph = snapshot();
    const original = structuredClone(graph.edges);
    const plan = planCycleRepairs(graph);
    expect(plan.candidates[0]).toMatchObject({ kind: 'contract-first-decomposition', graphRevision: 7, requiresHumanReview: true, cycleNodeIds: [a, b], patch: { addEdges: [], removeEdgeIds: [] }, simulation: { cyclesBefore: 1, cyclesAfter: 1, persisted: false } });
    expect(plan.candidates[0]?.evidence).toHaveLength(2);
    expect(graph.edges).toEqual(original);
  });

  it('returns no candidates for an acyclic graph and keeps output bounded', () => {
    const graph = snapshot();
    graph.edges.pop();
    expect(planCycleRepairs(graph).candidates).toEqual([]);
    expect(planCycleRepairs(snapshot(), 1)).toMatchObject({ totalCycles: 1, truncated: false });
  });
});
