import { describe, expect, it } from 'vitest';
import {
  canTransitionDecisionState,
  dependencyGraphEdgeSchema,
  dependencyDecisionWriteSchema,
  dependencyNodeId,
  dependencyGraphSnapshotJsonSchema,
  hasValidDependencyNodeIdentity,
  isVerifiedBlockingEdge,
  validateDependencyGraphSnapshot,
  type DependencyGraphEdge,
  type DependencyGraphSnapshot,
} from '@open-mercato/cezar-contract';

const at = '2026-10-30T12:00:00.000Z';
const repository = 'owner/repo';
const blockerId = dependencyNodeId('issue', repository, 10);
const blockedId = dependencyNodeId('issue', repository, 11);

function edge(overrides: Partial<DependencyGraphEdge> = {}): DependencyGraphEdge {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'BLOCKS',
    from: blockerId,
    to: blockedId,
    direction: 'from-to',
    provenance: {
      origin: 'github-native', authority: 'verified', confidence: 1, recordedAt: at,
      sourceRevision: 'etag-1', sourceUrl: 'https://github.com/owner/repo/issues/10', evidence: [],
    },
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function snapshot(overrides: Partial<DependencyGraphSnapshot> = {}): DependencyGraphSnapshot {
  return {
    schemaVersion: 1,
    repository,
    revision: 1,
    createdAt: at,
    source: { status: 'fresh', lastSuccessfulSyncAt: at, watermark: 'etag-1' },
    nodes: [
      { kind: 'issue', id: blockerId, repository, number: 10, title: 'Blocker', state: 'open', labels: [], url: 'https://github.com/owner/repo/issues/10', revision: 'etag-1', updatedAt: at },
      { kind: 'issue', id: blockedId, repository, number: 11, title: 'Blocked', state: 'open', labels: [], url: 'https://github.com/owner/repo/issues/11', revision: 'etag-1', updatedAt: at },
    ],
    edges: [edge()],
    decisions: [],
    ...overrides,
  };
}

describe('Dependency Intelligence v1 contracts', () => {
  it('uses repository-qualified IDs and keeps cross-repository references distinct', () => {
    expect(blockerId).toBe('issue:github.com/owner/repo:10');
    expect(dependencyNodeId('issue', 'other/repo', 10)).not.toBe(blockerId);
    expect(hasValidDependencyNodeIdentity(snapshot().nodes[0]!)).toBe(true);
    expect(hasValidDependencyNodeIdentity({ ...snapshot().nodes[0]!, id: dependencyNodeId('issue', repository, 99) })).toBe(false);
  });

  it('validates a verified BLOCKS edge with prerequisite-to-dependent direction', () => {
    const parsed = dependencyGraphEdgeSchema.parse(edge());
    expect(parsed.from).toBe(blockerId);
    expect(parsed.to).toBe(blockedId);
    expect(isVerifiedBlockingEdge(parsed)).toBe(true);
  });

  it('never treats inferred, uncertain, or non-BLOCKS edges as scheduler blockers', () => {
    expect(isVerifiedBlockingEdge(edge({ kind: 'RELATED_TO' }))).toBe(false);
    expect(isVerifiedBlockingEdge(edge({ provenance: { ...edge().provenance, authority: 'proposed' } }))).toBe(false);
    expect(isVerifiedBlockingEdge(edge({ provenance: { ...edge().provenance, origin: 'model' } }))).toBe(false);
    expect(validateDependencyGraphSnapshot(snapshot({ edges: [edge({ provenance: { ...edge().provenance, origin: 'model' } })] })))
      .toContain('model-origin edge 00000000-0000-4000-8000-000000000001 cannot be verified');
  });

  it('rejects dangling edges, duplicate nodes, and duplicate edge IDs in a snapshot', () => {
    const malformed = snapshot({
      nodes: [snapshot().nodes[0]!, snapshot().nodes[0]!],
      edges: [edge({ to: dependencyNodeId('issue', repository, 12) }), edge()],
    });
    expect(validateDependencyGraphSnapshot(malformed)).toEqual(expect.arrayContaining([
      `duplicate node ${blockerId}`,
      `edge 00000000-0000-4000-8000-000000000001 has missing dependent ${dependencyNodeId('issue', repository, 12)}`,
      'duplicate edge 00000000-0000-4000-8000-000000000001',
    ]));
  });

  it('defines bounded decision state transitions and exports machine-readable JSON Schema', () => {
    expect(canTransitionDecisionState('proposed', 'approved')).toBe(true);
    expect(canTransitionDecisionState('superseded', 'reopened')).toBe(false);
    expect(dependencyGraphSnapshotJsonSchema).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
    });
  });

  it('accepts bounded proposal writes while fixing their state and authorization defaults', () => {
    const proposal = dependencyDecisionWriteSchema.parse({
      expectedGraphRevision: 2,
      id: dependencyNodeId('decision', repository, '8d68f1a2'),
      question: 'Which rollout path should we use?',
      options: ['Gradual', 'Immediate'],
    });
    expect(proposal).toMatchObject({ state: 'proposed', requiredAuthorization: 'agent-proposal', reversible: false, evidence: [] });
    expect(dependencyDecisionWriteSchema.safeParse({ ...proposal, state: 'approved' }).success).toBe(true);
    expect(dependencyDecisionWriteSchema.safeParse({ ...proposal, options: ['Only one'] }).success).toBe(false);
  });
});
