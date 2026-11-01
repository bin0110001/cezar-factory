import { describe, expect, it } from 'vitest';
import { dependencyNodeId, type DependencyGraphSnapshot } from '@open-mercato/cezar-contract';
import { admitWithRefresh, evaluateDependencyAdmission } from './admission.ts';

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

describe('admission with on-demand refresh', () => {
  function fakeService(initial: DependencyGraphSnapshot, afterRefresh?: DependencyGraphSnapshot, refreshStatus: 'fresh' | 'stale' = 'fresh') {
    let current = initial;
    const calls: number[] = [];
    return {
      calls,
      read: () => current,
      refreshIfNeeded: async ({ maxAgeMs }: { maxAgeMs: number }) => {
        calls.push(maxAgeMs);
        if (afterRefresh && refreshStatus === 'fresh' && (current.source.status !== 'fresh' || maxAgeMs <= 30_000)) current = afterRefresh;
        return { repository, revision: 5, status: refreshStatus, full: false, complete: refreshStatus === 'fresh', nodesReceived: 0, edgesReceived: 0, ...(refreshStatus === 'stale' ? { warning: 'gh is not authenticated' } : {}) };
      },
    };
  }

  it('syncs a stale graph before deciding instead of deferring the work', async () => {
    const service = fakeService(snapshot('stale'), snapshot('fresh'));
    expect(await admitWithRefresh(service, repository, 1)).toMatchObject({ status: 'ready' });
    expect(service.calls).toHaveLength(1);
  });

  it('resyncs once when a fresh graph predates the issue', async () => {
    const withNew = snapshot();
    withNew.nodes = [...withNew.nodes, { ...withNew.nodes[0]!, id: dependencyNodeId('issue', repository, 3), number: 3, title: 'New' } as typeof withNew.nodes[number]];
    const service = fakeService(snapshot(), withNew);
    expect(await admitWithRefresh(service, repository, 3)).toMatchObject({ status: 'ready' });
    expect(service.calls).toHaveLength(2);
  });

  it('stays fail-closed and explains why when the refresh cannot reach GitHub', async () => {
    const service = fakeService(snapshot('stale'), undefined, 'stale');
    const verdict = await admitWithRefresh(service, repository, 1);
    expect(verdict.status).toBe('unknown');
    expect(verdict.reason).toContain('gh is not authenticated');
  });

  it('never moves the graph for the pre-dispatch recheck and still reports verified blockers', async () => {
    const service = fakeService(snapshot());
    expect(await admitWithRefresh(service, repository, 2, { refresh: false })).toMatchObject({ status: 'blocked' });
    expect(service.calls).toHaveLength(0);
  });
});
