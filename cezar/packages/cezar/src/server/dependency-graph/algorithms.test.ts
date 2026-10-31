import { describe, expect, it } from 'vitest';
import { dependencyNodeId, type DecisionRecord, type DependencyGraphEdge, type DependencyGraphSnapshot } from '@open-mercato/cezar-contract';
import { blockingCycles, dependencyGraphHealth, dependencyNeighborhood, diagnoseBlockingCycles, diffDependencySnapshots, downstreamImpact, rankDecisions, readiness, simulateDependencyGraph } from './algorithms.ts';

const at = '2026-10-30T12:00:00.000Z';
const repository = 'acme/work';
const ids = [1, 2, 3].map((n) => dependencyNodeId('issue', repository, n));
function edge(from: string, to: string, id: string): DependencyGraphEdge {
  return { id, kind: 'BLOCKS', from, to, direction: 'from-to', provenance: { origin: 'github-native', authority: 'verified', confidence: 1, recordedAt: at, evidence: [] }, createdAt: at, updatedAt: at };
}
function graph(status: DependencyGraphSnapshot['source']['status'] = 'fresh'): DependencyGraphSnapshot {
  return {
    schemaVersion: 1, repository, revision: 1, createdAt: at,
    source: { status, lastSuccessfulSyncAt: at },
    nodes: ids.map((id, i) => ({ kind: 'issue' as const, id, repository, number: i + 1, title: `Issue ${i + 1}`, state: i === 0 ? 'closed' as const : 'open' as const, labels: [], url: `https://github.com/acme/work/issues/${i + 1}`, revision: at, updatedAt: at })),
    edges: [edge(ids[0]!, ids[1]!, '00000000-0000-4000-8000-000000000001'), edge(ids[1]!, ids[2]!, '00000000-0000-4000-8000-000000000002')], decisions: [],
  };
}

describe('dependency graph algorithms', () => {
  it('computes readiness prerequisite-first and returns unknown for stale data', () => {
    expect(readiness(graph()).map((r) => r.readiness)).toEqual(['ready', 'ready', 'blocked']);
    expect(readiness(graph('stale'))[2]?.readiness).toBe('unknown');
  });

  it('summarizes health counts from the same readiness rules', () => {
    expect(dependencyGraphHealth(graph()).counts).toMatchObject({ ready: 1, blocked: 1, unknown: 0, openIssues: 2, verifiedBlockers: 2, cycles: 0 });
    expect(dependencyGraphHealth(graph('offline')).counts).toMatchObject({ ready: 0, blocked: 0, unknown: 2 });
    expect(dependencyGraphHealth(graph())).toMatchObject({ aging: { oldestOpenIssueAgeDays: null, unknownIssueAgeCount: 2, oldestBlockedIssueAgeDays: null, unknownBlockedAgeCount: 1 }, diagnostics: { bottlenecks: [{ nodeId: ids[1], directBlockedIssues: 1 }], obsoleteBlockers: [{ blockerId: ids[0], dependentId: ids[1] }] } });
  });

  it('finds deterministic strongly connected blocking components', () => {
    const snapshot = graph();
    snapshot.edges.push(edge(ids[2]!, ids[1]!, '00000000-0000-4000-8000-000000000003'));
    expect(blockingCycles(snapshot)).toEqual([[ids[1], ids[2]]]);
    expect(diagnoseBlockingCycles(snapshot)[0]?.witnessNodeIds).toEqual([ids[1], ids[2], ids[1]]);
    snapshot.edges.push(edge(ids[0]!, ids[0]!, '00000000-0000-4000-8000-000000000004'));
    const selfCycle = diagnoseBlockingCycles(snapshot).find((cycle) => cycle.nodeIds.length === 1);
    expect(selfCycle).toMatchObject({ nodeIds: [ids[0]], witnessNodeIds: [ids[0], ids[0]], witnessEdges: [snapshot.edges[3]] });
  });

  it('handles a long acyclic chain without recursive stack growth', () => {
    const snapshot = graph();
    const count = 5_000;
    snapshot.nodes = Array.from({ length: count }, (_, index) => {
      const number = index + 1;
      const id = dependencyNodeId('issue', repository, number);
      return { kind: 'issue' as const, id, repository, number, title: `Issue ${number}`, state: 'open' as const, labels: [], url: `https://github.com/acme/work/issues/${number}`, revision: at, updatedAt: at };
    });
    snapshot.edges = Array.from({ length: count - 1 }, (_, index) => edge(
      snapshot.nodes[index]!.id, snapshot.nodes[index + 1]!.id,
      `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
    ));
    expect(blockingCycles(snapshot)).toEqual([]);
  });

  it('bounds distinct downstream impact and ignores unverified suggestions', () => {
    const snapshot = graph();
    snapshot.edges.push({ ...edge(ids[0]!, ids[2]!, '00000000-0000-4000-8000-000000000003'), provenance: { ...edge(ids[0]!, ids[2]!, '00000000-0000-4000-8000-000000000003').provenance, authority: 'proposed' } });
    expect(downstreamImpact(snapshot, ids[0]!, 1)).toEqual({ count: 1, nodeIds: [ids[1]], truncated: true });
  });

  it('expands bounded upstream and downstream neighborhoods with typed edge filters', () => {
    const upstream = dependencyNeighborhood(graph(), ids[1]!, { direction: 'upstream', depth: 2, limit: 10 });
    expect(upstream?.nodes.map((node) => node.id)).toEqual([ids[0], ids[1]]);
    expect(upstream?.edges).toHaveLength(1);
    const bounded = dependencyNeighborhood(graph(), ids[1]!, { direction: 'both', depth: 2, limit: 1 });
    expect(bounded?.nodes).toHaveLength(1);
    expect(bounded?.truncated).toBe(true);
  });

  it('simulates bounded counterfactual changes without persisting or asserting new blockers', () => {
    const snapshot = graph();
    const simulated = simulateDependencyGraph(snapshot, { expectedRevision: 1, removeEdgeIds: ['00000000-0000-4000-8000-000000000002'], addEdges: [] });
    expect(simulated).toMatchObject({ persisted: false, revision: 1, before: [{ nodeId: ids[2], readiness: 'blocked' }], after: [{ nodeId: ids[2], readiness: 'ready' }] });
    expect(snapshot.edges).toHaveLength(2);
    expect(() => simulateDependencyGraph(snapshot, { expectedRevision: 0, removeEdgeIds: [], addEdges: [] })).toThrow(/revision conflict/);
  });

  it('simulates issue completion and decision outcomes in an isolated snapshot', () => {
    const snapshot = graph();
    const decisionId = dependencyNodeId('decision', repository, 'scenario');
    snapshot.nodes.push({ kind: 'decision', id: decisionId, repository, title: 'Select API contract', state: 'proposed', requiredAuthorization: 'human-approval', revision: 0, updatedAt: at });
    snapshot.edges.push(edge(decisionId, ids[2]!, '00000000-0000-4000-8000-000000000003'));
    snapshot.decisions.push({ id: decisionId, repository, question: 'Select API contract', options: ['A', 'B'], rationale: '', evidence: [], reversible: false, requiredAuthorization: 'human-approval', state: 'proposed', affectedNodeIds: [ids[2]!], createdBy: 'test', createdAt: at, updatedAt: at, revision: 0 });
    const result = simulateDependencyGraph(snapshot, { expectedRevision: 1, removeEdgeIds: [], addEdges: [], completeNodeIds: [ids[1]!], resolveDecisionIds: [decisionId] });
    expect(result).toMatchObject({ persisted: false, hypotheticalCompletions: [ids[1]], hypotheticalDecisionOutcomes: [decisionId], criticalPath: { status: 'unavailable' } });
    expect(result.after.find((item) => item.nodeId === ids[2])).toMatchObject({ readiness: 'ready' });
    expect(snapshot.nodes.find((node) => node.id === ids[1])?.state).toBe('open');
    expect(snapshot.decisions[0]?.state).toBe('proposed');
    expect(() => simulateDependencyGraph(snapshot, { expectedRevision: 1, addEdges: [], removeEdgeIds: [], resolveDecisionIds: [decisionId] })).not.toThrow();
  });

  it('rejects stale or invalid hypothetical completion targets', () => {
    const snapshot = graph();
    expect(() => simulateDependencyGraph(snapshot, { expectedRevision: 1, addEdges: [], removeEdgeIds: [], completeNodeIds: [ids[0]!] })).toThrow(/open issue or epic/);
  });

  it('computes bounded immutable snapshot diffs by stable node and edge identity', () => {
    const before = graph();
    const after = structuredClone(before);
    after.revision = 2;
    after.nodes[1] = { ...after.nodes[1]!, title: 'Updated title' };
    after.edges = [after.edges[0]!, edge(ids[0]!, ids[2]!, '00000000-0000-4000-8000-000000000003')];
    const diff = diffDependencySnapshots(before, after, 1);
    expect(diff).toMatchObject({ fromRevision: 1, toRevision: 2, nodes: { totals: { changed: 1 } }, edges: { totals: { added: 1, removed: 1 } } });
    expect(diffDependencySnapshots(before, after, 1).truncated).toBe(false);
    expect(() => diffDependencySnapshots(after, before)).toThrow(/increasing/);
  });

  it('ranks immediate unlocks above reach and explains unknown priority data', () => {
    const snapshot = graph();
    const decisionA = dependencyNodeId('decision', repository, 'wide');
    const decisionB = dependencyNodeId('decision', repository, 'unlock');
    const fourth = dependencyNodeId('issue', repository, 4);
    const fifth = dependencyNodeId('issue', repository, 5);
    snapshot.nodes = snapshot.nodes.map((node) => node.id === ids[0] && (node.kind === 'issue' || node.kind === 'epic') ? { ...node, state: 'open' } : node);
    snapshot.nodes.push({ kind: 'issue', id: fourth, repository, number: 4, title: 'Fourth', state: 'open', labels: [], url: 'https://github.com/acme/work/issues/4', revision: at, createdAt: '2026-09-30T12:00:00.000Z', updatedAt: at });
    snapshot.nodes.push({ kind: 'issue', id: fifth, repository, number: 5, title: 'Fifth', state: 'open', labels: [], url: 'https://github.com/acme/work/issues/5', revision: at, updatedAt: at });
    snapshot.nodes.push(...[decisionA, decisionB].map((id) => ({ kind: 'decision' as const, id, repository, title: id, state: 'proposed' as const, requiredAuthorization: 'agent-proposal' as const, revision: 0, updatedAt: at })));
    const wide = edge(decisionA, ids[1]!, '00000000-0000-4000-8000-000000000003');
    const wideReach = edge(ids[1]!, fourth, '00000000-0000-4000-8000-000000000004');
    const short = edge(decisionB, fifth, '00000000-0000-4000-8000-000000000005');
    snapshot.edges.push(wide, wideReach, short);
    const record = (id: string): DecisionRecord => ({ id, repository, question: id, options: ['A', 'B'], rationale: '', evidence: [], reversible: true, requiredAuthorization: 'agent-proposal', state: 'proposed', affectedNodeIds: [], createdBy: 'test', createdAt: at, updatedAt: at, revision: 0 });
    snapshot.decisions = [record(decisionA), record(decisionB)];
    const ranked = rankDecisions(snapshot);
    expect(ranked.decisions[0]).toMatchObject({ id: decisionB, immediateUnlock: 1, downstreamReach: 1 });
    expect(ranked.decisions[1]).toMatchObject({ id: decisionA, immediateUnlock: 0, downstreamReach: 3, unknownPriorityReach: 3 });
    expect(ranked.decisions[1]).toMatchObject({ oldestAffectedIssueAgeDays: 30, unknownAgeReach: 2, blockedDuration: { status: 'unavailable' } });
    expect(ranked.bundles[0]?.newlyUnlocked).toBe(1);
  });

  it('searches bounded decision bundles and counts only work newly released by the bundle', () => {
    const snapshot = graph();
    const first = dependencyNodeId('decision', repository, 'bundle-a');
    const second = dependencyNodeId('decision', repository, 'bundle-b');
    const taskId = dependencyNodeId('issue', repository, 99);
    snapshot.nodes.push({ kind: 'issue', id: taskId, repository, number: 99, title: 'Needs both decisions', state: 'open', labels: [], url: 'https://github.com/acme/work/issues/99', revision: at, updatedAt: at });
    snapshot.nodes.push(...[first, second].map((id) => ({ kind: 'decision' as const, id, repository, title: id, state: 'proposed' as const, requiredAuthorization: 'agent-proposal' as const, revision: 0, updatedAt: at })));
    snapshot.edges.push(edge(first, taskId, '00000000-0000-4000-8000-000000000009'), edge(second, taskId, '00000000-0000-4000-8000-000000000010'));
    const record = (id: string): DecisionRecord => ({ id, repository, question: id, options: ['A', 'B'], rationale: '', evidence: [], reversible: true, requiredAuthorization: 'agent-proposal', state: 'proposed', affectedNodeIds: [], createdBy: 'test', createdAt: at, updatedAt: at, revision: 0 });
    snapshot.decisions = [record(first), record(second)];
    const ranking = rankDecisions(snapshot);
    expect(ranking.bundles.find((bundle) => bundle.decisionIds.join('|') === [first, second].sort().join('|'))).toMatchObject({ newlyUnlocked: 1, taskIds: [taskId] });
    expect(ranking.bundles.find((bundle) => bundle.decisionIds.length === 2)?.decisionIds).toEqual([first, second].sort());
  });
});
