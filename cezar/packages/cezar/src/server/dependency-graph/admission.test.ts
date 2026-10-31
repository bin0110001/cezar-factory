import { describe, expect, it } from 'vitest';
import { dependencyNodeId, type DependencyGraphSnapshot } from '@open-mercato/cezar-contract';
import { evaluateDependencyAdmission } from './admission.ts';

const repository = 'acme/work';
const at = '2026-10-30T12:00:00.000Z';
function snapshot(status: DependencyGraphSnapshot['source']['status'] = 'fresh'): DependencyGraphSnapshot {
  const blocker = dependencyNodeId('issue', repository, 1);
  const target = dependencyNodeId('issue', repository, 2);
  return {
    schemaVersion: 1, repository, revision: 4, createdAt: at,
    source: { status, lastSuccessfulSyncAt: at },
    nodes: [
      { kind: 'issue', id: blocker, repository, number: 1, title: 'Blocker', state: 'open', labels: [], url: 'https://github.com/acme/work/issues/1', revision: at, updatedAt: at },
      { kind: 'issue', id: target, repository, number: 2, title: 'Target', state: 'open', labels: [], url: 'https://github.com/acme/work/issues/2', revision: at, updatedAt: at },
    ],
    edges: [{ id: '00000000-0000-4000-8000-000000000001', kind: 'BLOCKS', from: blocker, to: target, direction: 'from-to', provenance: { origin: 'github-native', authority: 'verified', confidence: 1, recordedAt: at, evidence: [] }, createdAt: at, updatedAt: at }],
    decisions: [],
  };
}

describe('dependency admission', () => {
  it('admits only a fresh open issue without unresolved verified blockers', () => {
    expect(evaluateDependencyAdmission(snapshot(), repository, 1).status).toBe('ready');
    expect(evaluateDependencyAdmission(snapshot(), repository, 2)).toMatchObject({ status: 'blocked', blockers: ['issue:github.com/acme/work:1'] });
  });

  it('fails closed for stale, absent, and closed issues', () => {
    expect(evaluateDependencyAdmission(snapshot('stale'), repository, 1).status).toBe('unknown');
    expect(evaluateDependencyAdmission(snapshot(), repository, 3).status).toBe('unknown');
    const closed = snapshot();
    closed.nodes = closed.nodes.map((node) => node.kind === 'issue' && node.number === 1 ? { ...node, state: 'closed' } : node);
    expect(evaluateDependencyAdmission(closed, repository, 1).status).toBe('closed');
  });
});
