import { describe, expect, it } from 'vitest';
import type { DecisionRecord, DependencyGraphSnapshot, GithubRepositoryKey } from '@open-mercato/cezar-contract';
import { DependencyGraphService, type DependencyGraphStorePort } from './service.ts';

const repo: GithubRepositoryKey = 'acme/work';
const now = '2026-10-30T12:00:00.000Z';

class MemoryStore implements DependencyGraphStorePort {
  snapshot: DependencyGraphSnapshot = { schemaVersion: 1, repository: repo, revision: 0, createdAt: now, source: { status: 'unknown' }, nodes: [], edges: [], decisions: [] };
  history = new Map<number, DependencyGraphSnapshot>();
  readSnapshot(_repository?: GithubRepositoryKey, revision?: number) { return revision === undefined ? this.snapshot : this.history.get(revision) ?? this.snapshot; }
  readSnapshotIndex(_repository: GithubRepositoryKey, limit = 100) { return [...this.history.entries()].map(([revision, snapshot]) => ({ revision, createdAt: snapshot.createdAt })).sort((a, b) => b.revision - a.revision).slice(0, limit); }
  applySync(input: Parameters<DependencyGraphStorePort['applySync']>[0]) {
    this.snapshot = { schemaVersion: 1, repository: input.repository, revision: this.snapshot.revision + 1, createdAt: now,
      source: { status: input.status, ...(input.complete ? { lastSuccessfulSyncAt: now } : {}), ...(input.watermark ? { watermark: input.watermark } : {}), ...(input.warning ? { warning: input.warning } : {}) },
      nodes: input.nodes, edges: input.edges, decisions: input.decisions ?? [] };
    this.history.set(this.snapshot.revision, structuredClone(this.snapshot));
    return this.snapshot.revision;
  }
  setUnavailable(repository: GithubRepositoryKey, status: 'stale' | 'offline' | 'unknown', warning: string) {
    this.snapshot = { ...this.snapshot, repository, revision: this.snapshot.revision + 1, source: { ...this.snapshot.source, status, warning } };
    this.history.set(this.snapshot.revision, structuredClone(this.snapshot));
  }
  writeDecision(repository: GithubRepositoryKey, decision: DecisionRecord, expected: number) {
    if (expected !== this.snapshot.revision) throw new Error('dependency graph revision conflict');
    const revision = expected + 1;
    const prior = this.snapshot.decisions.find((item) => item.id === decision.id);
    const updated = { ...decision, revision: (prior?.revision ?? -1) + 1 };
    this.snapshot = { ...this.snapshot, repository, revision, decisions: [...this.snapshot.decisions.filter((item) => item.id !== decision.id), updated] };
    this.history.set(revision, structuredClone(this.snapshot));
    return revision;
  }
  reserveCycleAgentAttempt(_repository: GithubRepositoryKey, expected: number, _fingerprint: string) {
    if (expected !== this.snapshot.revision) throw new Error('dependency graph revision conflict');
    return { allowed: true, attempt: 1 };
  }
  reserveDecisionResearchAttempt(_repository: GithubRepositoryKey, expected: number, _fingerprint: string) {
    if (expected !== this.snapshot.revision) throw new Error('dependency graph revision conflict');
    return { allowed: true, attempt: 1 };
  }
  recordCycleAgentResult() {}
  recordDecisionResearchResult() {}
  readEvents() { return []; }
  close() {}
}

function pageJson() {
  return JSON.stringify({ data: { repository: { nameWithOwner: 'acme/work', url: 'https://github.com/acme/work', issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } });
}

describe('dependency graph sync coordinator', () => {
  it('performs an explicit bounded full sync and shares concurrent requests', async () => {
    const store = new MemoryStore();
    let calls = 0;
    const service = new DependencyGraphService('C:/repo', {
      store,
      gitRunner: async () => 'https://github.com/acme/work.git',
      ghRunner: async () => { calls += 1; return pageJson(); },
      env: {},
    });
    const [a, b] = await Promise.all([service.sync(), service.sync()]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ status: 'fresh', full: true, complete: true, revision: 1 });
    expect(calls).toBe(1);
    service.close();
  });

  it('retains a stale local projection when GitHub is unavailable', async () => {
    const store = new MemoryStore();
    store.snapshot = { ...store.snapshot, revision: 4, source: { status: 'fresh', lastSuccessfulSyncAt: now } };
    const service = new DependencyGraphService('C:/repo', {
      store,
      gitRunner: async () => 'https://github.com/acme/work.git',
      ghRunner: async () => { throw new Error('gho_sensitive-token'); },
      env: {},
    });
    const result = await service.sync();
    expect(result).toMatchObject({ status: 'stale', revision: 5 });
    expect(result.warning).not.toContain('sensitive-token');
    expect(store.snapshot.source.status).toBe('stale');
    service.close();
  });

  it('downgrades old cached freshness for read-only callers', async () => {
    const store = new MemoryStore();
    store.snapshot = { ...store.snapshot, revision: 1, source: { status: 'fresh', lastSuccessfulSyncAt: '2020-01-01T00:00:00.000Z' } };
    const service = new DependencyGraphService('C:/repo', { store, gitRunner: async () => 'https://github.com/acme/work.git', ghRunner: async () => pageJson(), env: {} });
    expect((service.read(repo).source).status).toBe('stale');
    service.close();
  });

  it('reuses immutable analysis for one revision and invalidates it after a source revision', async () => {
    const store = new MemoryStore();
    store.snapshot = { ...store.snapshot, revision: 1, source: { status: 'fresh', lastSuccessfulSyncAt: now } };
    const service = new DependencyGraphService('C:/repo', { store, gitRunner: async () => 'https://github.com/acme/work.git', ghRunner: async () => pageJson(), env: {} });
    const first = service.analysis(repo);
    expect(service.analysis(repo)).toBe(first);
    store.setUnavailable(repo, 'stale', 'simulated outage');
    expect(service.analysis(repo)).not.toBe(first);
    expect(service.analysis(repo).readiness).toEqual([]);
    service.close();
  });

  it('uses snapshot revisions and the declared transition graph for local review actions', async () => {
    const store = new MemoryStore();
    const decision: DecisionRecord = {
      id: 'decision:github.com/acme/work:review-1', repository: repo, question: 'Choose a contract', options: ['A', 'B'],
      rationale: '', evidence: [], reversible: true, requiredAuthorization: 'human-approval', state: 'proposed',
      affectedNodeIds: [], createdBy: 'agent', createdAt: now, updatedAt: now, revision: 0,
    };
    store.snapshot = { ...store.snapshot, revision: 1, source: { status: 'fresh', lastSuccessfulSyncAt: now }, decisions: [decision] };
    const service = new DependencyGraphService('C:/repo', { store, gitRunner: async () => 'https://github.com/acme/work.git', ghRunner: async () => pageJson(), env: {} });
    await expect(service.transitionDecision(decision.id, 'approved', 0)).rejects.toThrow(/revision conflict/);
    await expect(service.transitionDecision(decision.id, 'resolved', 1)).rejects.toThrow(/invalid decision transition/);
    const result = await service.transitionDecision(decision.id, 'approved', 1);
    expect(result).toMatchObject({ revision: 2, decision: { state: 'approved', revision: 1 } });
    service.close();
  });

  it('samples weekly immutable history and reports resolved-decision changes', () => {
    const store = new MemoryStore();
    const decision: DecisionRecord = {
      id: 'decision:github.com/acme/work:trend-1', repository: repo, question: 'Choose a version', options: ['A', 'B'],
      rationale: '', evidence: [], reversible: true, requiredAuthorization: 'human-approval', state: 'resolved', resolution: 'A',
      affectedNodeIds: [], createdBy: 'operator', createdAt: now, updatedAt: now, revision: 0,
    };
    store.history.set(1, { ...store.snapshot, revision: 1, createdAt: '2026-10-20T12:00:00.000Z', source: { status: 'fresh' } });
    store.snapshot = { ...store.snapshot, revision: 2, createdAt: now, source: { status: 'fresh' }, decisions: [decision] };
    store.history.set(2, structuredClone(store.snapshot));
    const service = new DependencyGraphService('C:/repo', { store, gitRunner: async () => 'https://github.com/acme/work.git', ghRunner: async () => pageJson(), env: {} });
    expect(service.historicalTrends(repo).points).toMatchObject([
      { week: '2026-10-19', revision: 1, resolvedDecisions: 0, resolvedDecisionDelta: 0 },
      { week: '2026-10-26', revision: 2, resolvedDecisions: 1, resolvedDecisionDelta: 1 },
    ]);
    service.close();
  });
});
