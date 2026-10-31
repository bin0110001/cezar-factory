import { describe, expect, it } from 'vitest';
import { dependencyNodeId, type DependencyGraphEdge, type DependencyGraphSnapshot } from '@open-mercato/cezar-contract';
import { discoverDecisionCandidates } from './discovery.ts';

const at = '2026-10-30T12:00:00.000Z';
const repository = 'acme/work';
const ids = [1, 2, 3].map((number) => dependencyNodeId('issue', repository, number));
const edge = (from: string, to: string, suffix: string): DependencyGraphEdge => ({
  id: `00000000-0000-4000-8000-00000000000${suffix}`,
  kind: 'BLOCKS', from, to, direction: 'from-to',
  provenance: { origin: 'github-native', authority: 'verified', confidence: 1, recordedAt: at, evidence: [] }, createdAt: at, updatedAt: at,
});

function graph(): DependencyGraphSnapshot {
  return {
    schemaVersion: 1, repository, revision: 7, createdAt: at, source: { status: 'fresh', lastSuccessfulSyncAt: at },
    nodes: ids.map((id, index) => ({
      kind: 'issue' as const, id, repository, number: index + 1, title: `Issue ${index + 1}`,
      state: index === 0 ? 'open' as const : 'open' as const, labels: [], bodyText: index === 0 ? undefined : index === 1
        ? 'Which worker contract should we agree on? The service is blocked.'
        : 'Should we agree on the worker contract? The client is waiting.',
      url: `https://github.com/acme/work/issues/${index + 1}`, revision: at, updatedAt: at,
    })),
    edges: [edge(ids[0]!, ids[1]!, '001'), edge(ids[0]!, ids[2]!, '002')], decisions: [],
  };
}

describe('decision candidate mining', () => {
  it('groups repeated unresolved issue questions with evidence and never changes the graph', () => {
    const snapshot = graph();
    const before = JSON.stringify(snapshot);
    const first = discoverDecisionCandidates(snapshot);
    expect(first.candidates).toHaveLength(1);
    expect(first.candidates[0]).toMatchObject({
      affectedNodeIds: [ids[1], ids[2]], sharedBlockerIds: [ids[0]], confidence: 0.7,
    });
    expect(first.candidates[0]?.evidence).toHaveLength(2);
    expect(discoverDecisionCandidates(snapshot).candidates[0]?.id).toBe(first.candidates[0]?.id);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('suppresses a candidate already represented by a decision and marks bounded scans', () => {
    const snapshot = graph();
    snapshot.decisions.push({
      id: dependencyNodeId('decision', repository, 'worker-contract'), repository,
      question: 'Should we agree on the worker contract?', options: ['A', 'B'], rationale: '', evidence: [], reversible: true,
      requiredAuthorization: 'agent-proposal', state: 'proposed', affectedNodeIds: [], createdBy: 'test', createdAt: at, updatedAt: at, revision: 0,
    });
    expect(discoverDecisionCandidates(snapshot).candidates).toHaveLength(0);
    expect(discoverDecisionCandidates(snapshot, { scanLimit: 1 }).truncated).toBe(true);
  });

  it('deduplicates an automatically persisted proposal by its stable discovery identity', () => {
    const snapshot = graph();
    const candidate = discoverDecisionCandidates(snapshot).candidates[0]!;
    snapshot.decisions.push({
      id: dependencyNodeId('decision', repository, `discovery-${candidate.id}`), repository,
      question: `How should the shared question be resolved: ${candidate.question}`, options: ['A', 'B'], rationale: '', evidence: [], reversible: true,
      requiredAuthorization: 'agent-proposal', state: 'proposed', affectedNodeIds: candidate.affectedNodeIds, createdBy: 'dependency-discovery-scanner', createdAt: at, updatedAt: at, revision: 0,
    });
    expect(discoverDecisionCandidates(snapshot).candidates).toHaveLength(0);
  });

  it('finds shared prerequisite clusters even when blocked issues use different wording', () => {
    const snapshot = graph();
    for (const node of snapshot.nodes) if (node.kind === 'issue') node.bodyText = node.number === 2 ? 'Implement the API surface.' : node.number === 3 ? 'Update the user interface.' : undefined;
    const candidates = discoverDecisionCandidates(snapshot).candidates;
    expect(candidates.some((candidate) => candidate.sharedBlockerIds.includes(ids[0]!) && candidate.affectedNodeIds.length === 2)).toBe(true);
  });
});
