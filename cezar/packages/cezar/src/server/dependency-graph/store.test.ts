import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dependencyNodeId, type DependencyGraphEdge, type DependencyGraphNode } from '@open-mercato/cezar-contract';
import { DependencyGraphStore } from './store.ts';

const at = '2026-10-30T12:00:00.000Z';
const repository = 'acme/work';
const tempDirs: string[] = [];

function fixtureNodes(): DependencyGraphNode[] {
  return [1, 2].map((number) => ({
    kind: 'issue' as const,
    id: dependencyNodeId('issue', repository, number),
    repository,
    number,
    title: `Issue ${number}`,
    state: 'open' as const,
    labels: [],
    url: `https://github.com/acme/work/issues/${number}`,
    revision: 'etag-1',
    updatedAt: at,
  }));
}

function fixtureEdges(nodes = fixtureNodes()): DependencyGraphEdge[] {
  return [{
    id: '00000000-0000-5000-8000-000000000001',
    kind: 'BLOCKS', from: nodes[0]!.id, to: nodes[1]!.id, direction: 'from-to',
    provenance: { origin: 'github-native', authority: 'verified', confidence: 1, recordedAt: at, sourceRevision: 'etag-1', evidence: [] },
    createdAt: at, updatedAt: at,
  }];
}

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'cez-dependency-graph-'));
  tempDirs.push(resolve(base));
  const repoRoot = join(base, 'repo');
  const home = join(base, 'home');
  return { repoRoot, home, store: new DependencyGraphStore(repoRoot, { home }) };
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    if (path.startsWith(resolve(tmpdir()) + '\\') || path.startsWith(resolve(tmpdir()) + '/')) rmSync(path, { recursive: true, force: true });
  }
});

describe('DependencyGraphStore', () => {
  it('creates a versioned database, commits a complete projection, and survives restart', () => {
    const { repoRoot, home, store } = setup();
    const nodes = fixtureNodes();
    const edges = fixtureEdges(nodes);
    const first = store.applySync({ repository, nodes, edges, full: true, complete: true, watermark: at, status: 'fresh', now: at });
    expect(first).toBe(1);
    expect(store.readSnapshot(repository)).toMatchObject({ revision: 1, source: { status: 'fresh', watermark: at }, nodes, edges });
    store.close();

    const reopened = new DependencyGraphStore(repoRoot, { home });
    expect(reopened.readSnapshot(repository)).toMatchObject({ revision: 1, nodes, edges });
    reopened.close();
  });

  it('replays idempotently, records each sync revision, and keeps cached data available offline', () => {
    const { store } = setup();
    const nodes = fixtureNodes();
    const edges = fixtureEdges(nodes);
    store.applySync({ repository, nodes, edges, full: true, complete: true, watermark: at, status: 'fresh', now: at });
    store.applySync({ repository, nodes, edges, full: false, complete: true, watermark: at, status: 'fresh', now: at });
    store.setUnavailable(repository, 'offline', 'GitHub not reachable', '2026-10-30T13:00:00.000Z');
    const snapshot = store.readSnapshot(repository);
    expect(snapshot.revision).toBe(3);
    expect(snapshot.nodes).toHaveLength(2);
    expect(snapshot.edges).toHaveLength(1);
    expect(snapshot.source.status).toBe('offline');
    expect(snapshot.source.lastSuccessfulSyncAt).toBe(at);
    store.close();
  });

  it('removes stale native rows only after a complete full consistency pass', () => {
    const { store } = setup();
    const nodes = fixtureNodes();
    store.applySync({ repository, nodes, edges: fixtureEdges(nodes), full: true, complete: true, watermark: at, status: 'fresh', now: at });
    store.applySync({ repository, nodes: [nodes[0]!], edges: [], full: true, complete: false, watermark: at, status: 'unknown', warning: 'partial page', now: at });
    expect(store.readSnapshot(repository).nodes).toHaveLength(2);
    store.applySync({ repository, nodes: [nodes[0]!], edges: [], full: true, complete: true, watermark: at, status: 'fresh', now: at });
    expect(store.readSnapshot(repository).nodes).toHaveLength(1);
    expect(store.readSnapshot(repository).edges).toHaveLength(0);
    store.close();
  });

  it('uses graph revision compare-and-swap and retains decision versions with an audit trail', () => {
    const { store } = setup();
    const id = dependencyNodeId('decision', repository, 'rollout-1');
    const decision = {
      id, repository, question: 'How should this roll out?', options: ['Gradual', 'Immediate'],
      rationale: '', evidence: [], reversible: true, requiredAuthorization: 'agent-proposal' as const,
      state: 'proposed' as const, affectedNodeIds: [], createdBy: 'test-agent', createdAt: at, updatedAt: at, revision: 0,
    };
    expect(store.writeDecision(repository, decision, 0, at)).toBe(1);
    expect(() => store.writeDecision(repository, decision, 0, at)).toThrow(/revision conflict/);
    expect(store.writeDecision(repository, { ...decision, question: 'Revised rollout question' }, 1, at)).toBe(2);
    expect(store.readSnapshot(repository, 1).decisions[0]?.question).toBe(decision.question);
    expect(store.readSnapshot(repository).decisions[0]).toMatchObject({ question: 'Revised rollout question', revision: 1, createdAt: at, createdBy: 'test-agent' });
    expect(store.readSnapshot(repository).nodes.map((node) => node.id)).toContain(id);
    expect(store.readEvents(repository, 10).map((event) => event.kind)).toEqual(['decision-updated', 'decision-created']);
    store.close();
  });
});
