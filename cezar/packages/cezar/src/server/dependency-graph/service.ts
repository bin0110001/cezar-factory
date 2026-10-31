import {
  type DependencyGraphSnapshot,
  type DecisionRecord,
  type GithubRepositoryKey,
  canTransitionDecisionState,
} from '@open-mercato/cezar-contract';
import {
  DEPENDENCY_GRAPH_FULL_SYNC_INTERVAL_MS,
  DEPENDENCY_GRAPH_INCREMENTAL_OVERLAP_MS,
  DEPENDENCY_GRAPH_MAX_PAGES,
  GithubDependencySource,
  type DependencyGraphGhRunner,
  type DependencyGraphGitRunner,
} from './github-source.ts';
import { DependencyGraphStore } from './store.ts';
import { dependencyGraphHealth, diagnoseBlockingCycles, rankDecisions as computeDecisionRanking, readiness as computeReadiness } from './algorithms.ts';

export interface DependencyGraphSyncResult {
  repository: GithubRepositoryKey;
  revision: number;
  status: 'fresh' | 'stale' | 'offline' | 'unknown';
  full: boolean;
  complete: boolean;
  nodesReceived: number;
  edgesReceived: number;
  warning?: string;
}

export type DependencyGraphStorePort = Pick<DependencyGraphStore, 'readSnapshot' | 'readSnapshotIndex' | 'readEvents' | 'applySync' | 'setUnavailable' | 'writeDecision' | 'reserveCycleAgentAttempt' | 'recordCycleAgentResult' | 'reserveDecisionResearchAttempt' | 'recordDecisionResearchResult' | 'close'>;

function safeReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw.split('\n').map((line) => line.trim()).find(Boolean) ?? 'GitHub request failed';
  if (/ENOENT/.test(firstLine)) return 'GitHub CLI is unavailable. Install gh and authenticate with the GitHub host.';
  return firstLine.replace(/(?:gho|ghp|github_pat)_[A-Za-z0-9_]+/g, '[redacted]').slice(0, 1_000);
}

/** Per-repository sync coordinator. No network work starts until the caller explicitly requests it. */
export class DependencyGraphService {
  private readonly source: GithubDependencySource;
  private readonly store: DependencyGraphStorePort;
  private readonly env: NodeJS.ProcessEnv;
  private lastRepository?: GithubRepositoryKey;
  private inFlight?: Promise<DependencyGraphSyncResult>;
  private decisionRankCache?: { key: string; value: ReturnType<typeof computeDecisionRanking> };
  private analysisCache?: { key: string; value: { snapshot: DependencyGraphSnapshot; readiness: ReturnType<typeof computeReadiness>; cycles: ReturnType<typeof diagnoseBlockingCycles>; health: ReturnType<typeof dependencyGraphHealth> } };

  constructor(repoRoot: string, options: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    ghRunner?: DependencyGraphGhRunner;
    gitRunner?: DependencyGraphGitRunner;
    store?: DependencyGraphStorePort;
  } = {}) {
    this.env = options.env ?? process.env;
    this.source = new GithubDependencySource(repoRoot, options.ghRunner, options.gitRunner);
    this.store = options.store ?? new DependencyGraphStore(repoRoot, options);
  }

  read(repository: GithubRepositoryKey): DependencyGraphSnapshot {
    const snapshot = this.store.readSnapshot(repository);
    const lastSuccess = snapshot.source.lastSuccessfulSyncAt ? Date.parse(snapshot.source.lastSuccessfulSyncAt) : 0;
    if (snapshot.source.status === 'fresh' && lastSuccess > 0 && Date.now() - lastSuccess >= DEPENDENCY_GRAPH_FULL_SYNC_INTERVAL_MS) {
      return { ...snapshot, source: { ...snapshot.source, status: 'stale', warning: 'The last complete GitHub sync is more than 24 hours old.' } };
    }
    return snapshot;
  }

  readAt(repository: GithubRepositoryKey, revision: number): DependencyGraphSnapshot {
    return this.store.readSnapshot(repository, revision);
  }

  async repositoryKey(): Promise<GithubRepositoryKey> {
    return (await this.source.repository()).key;
  }

  async writeDecision(decision: DecisionRecord, expectedGraphRevision: number, actor = decision.createdBy, audit?: { rationale: string }): Promise<number> {
    return this.store.writeDecision(await this.repositoryKey(), decision, expectedGraphRevision, new Date().toISOString(), actor, audit);
  }

  async reserveCycleAgentAttempt(repository: GithubRepositoryKey, expectedGraphRevision: number, fingerprint: string) {
    return this.store.reserveCycleAgentAttempt(repository, expectedGraphRevision, fingerprint);
  }

  async recordCycleAgentResult(repository: GithubRepositoryKey, fingerprint: string, outcome: { status: 'started' | 'stale' | 'failed'; runId?: string; reason?: string }) {
    this.store.recordCycleAgentResult(repository, fingerprint, outcome);
  }

  async reserveDecisionResearchAttempt(repository: GithubRepositoryKey, expectedGraphRevision: number, fingerprint: string) {
    return this.store.reserveDecisionResearchAttempt(repository, expectedGraphRevision, fingerprint);
  }

  async recordDecisionResearchResult(repository: GithubRepositoryKey, fingerprint: string, outcome: { status: 'started' | 'stale' | 'failed'; runId?: string; reason?: string }) {
    this.store.recordDecisionResearchResult(repository, fingerprint, outcome);
  }

  async transitionDecision(decisionId: string, to: DecisionRecord['state'], expectedGraphRevision: number, resolution?: string): Promise<{ revision: number; decision: DecisionRecord }> {
    const repository = await this.repositoryKey();
    const snapshot = this.read(repository);
    if (snapshot.revision !== expectedGraphRevision) throw new Error(`dependency graph revision conflict: expected ${expectedGraphRevision}, found ${snapshot.revision}`);
    const decision = snapshot.decisions.find((item) => item.id === decisionId);
    if (!decision) throw new Error(`decision not found: ${decisionId}`);
    if (decision.requiredAuthorization === 'read-only') throw new Error('decision is read-only');
    if (!canTransitionDecisionState(decision.state, to)) throw new Error(`invalid decision transition: ${decision.state} -> ${to}`);
    if (to === 'resolved' && !resolution?.trim()) throw new Error('resolution text is required when resolving a decision');
    const updated = { ...decision, state: to, ...(resolution !== undefined ? { resolution } : {}) };
    const revision = this.store.writeDecision(repository, updated, expectedGraphRevision, new Date().toISOString(), 'local-operator');
    return { revision, decision: { ...updated, revision: decision.revision + 1 } };
  }

  async readEvents(limit = 100, beforeCursor?: number) {
    return this.store.readEvents(await this.repositoryKey(), limit, beforeCursor);
  }

  decisionRanking(repository: GithubRepositoryKey, limit = 20) {
    const snapshot = this.read(repository);
    const key = `${repository}:${snapshot.revision}:${snapshot.source.status}`;
    if (this.decisionRankCache?.key !== key) {
      this.decisionRankCache = { key, value: computeDecisionRanking(snapshot, { limit: 100 }) };
    }
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const value = this.decisionRankCache.value;
    return { ...value, decisions: value.decisions.slice(0, boundedLimit), truncated: value.truncated || value.decisions.length > boundedLimit };
  }

  analysis(repository: GithubRepositoryKey) {
    const snapshot = this.read(repository);
    const key = `${repository}:${snapshot.revision}:${snapshot.source.status}`;
    if (this.analysisCache?.key !== key) this.analysisCache = {
      key,
      value: { snapshot, readiness: computeReadiness(snapshot), cycles: diagnoseBlockingCycles(snapshot), health: dependencyGraphHealth(snapshot) },
    };
    return this.analysisCache.value;
  }

  /** Weekly history samples are immutable snapshots, bounded by both revision count and output size. */
  historicalTrends(repository: GithubRepositoryKey, revisionLimit = 100) {
    const current = this.read(repository);
    const bounded = Math.max(1, Math.min(100, Math.floor(revisionLimit)));
    const byWeek = new Map<string, DependencyGraphSnapshot>();
    const index = this.store.readSnapshotIndex(repository, bounded);
    for (const ref of index) {
      const created = new Date(ref.createdAt);
      const day = created.getUTCDay();
      created.setUTCDate(created.getUTCDate() - ((day + 6) % 7));
      const week = created.toISOString().slice(0, 10);
      if (!byWeek.has(week)) byWeek.set(week, this.store.readSnapshot(repository, ref.revision));
    }
    const points = [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, snapshot]) => {
      const health = dependencyGraphHealth(snapshot);
      return {
        week,
        revision: snapshot.revision,
        sourceStatus: snapshot.source.status,
        readiness: { ready: health.counts.ready, blocked: health.counts.blocked, unknown: health.counts.unknown },
        cycles: health.counts.cycles,
        oldestBlockedIssueAgeDays: health.aging.oldestBlockedIssueAgeDays,
        resolvedDecisions: snapshot.decisions.filter((decision) => decision.state === 'resolved').length,
        cycleSignatures: health.diagnostics.cycles.map((cycle) => [...cycle].sort().join('|')).sort(),
      };
    });
    return {
      repository,
      fromRevision: points[0]?.revision ?? current.revision,
      toRevision: current.revision,
      points: points.map((point, index) => ({
        ...point,
        resolvedDecisionDelta: index === 0 ? 0 : point.resolvedDecisions - points[index - 1]!.resolvedDecisions,
        recurringCycleSignatures: index === 0 ? [] : point.cycleSignatures.filter((signature) => points.slice(0, index).some((prior) => prior.cycleSignatures.includes(signature))),
      })),
      truncated: index.length < current.revision,
    };
  }

  sync(): Promise<DependencyGraphSyncResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.syncOnce().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async syncOnce(): Promise<DependencyGraphSyncResult> {
    let repository: GithubRepositoryKey | undefined;
    try {
      const repo = await this.source.repository();
      repository = repo.key;
      this.lastRepository = repo.key;
      if (this.env.CEZ_DRY_RUN === '1') {
        this.store.setUnavailable(repo.key, 'offline', 'GitHub synchronization is disabled in dry-run mode.');
        return { repository: repo.key, revision: this.store.readSnapshot(repo.key).revision, status: 'offline', full: false, complete: false, nodesReceived: 0, edgesReceived: 0, warning: 'GitHub synchronization is disabled in dry-run mode.' };
      }
      const previous = this.store.readSnapshot(repo.key);
      const lastSuccess = previous.source.lastSuccessfulSyncAt ? Date.parse(previous.source.lastSuccessfulSyncAt) : 0;
      const full = previous.revision === 0
        || previous.source.status === 'unknown'
        || previous.source.status === 'offline'
        || Date.now() - lastSuccess >= DEPENDENCY_GRAPH_FULL_SYNC_INTERVAL_MS;
      const previousWatermark = previous.source.watermark ? Date.parse(previous.source.watermark) : 0;
      const cutoff = full ? 0 : Math.max(0, previousWatermark - DEPENDENCY_GRAPH_INCREMENTAL_OVERLAP_MS);
      const nodes = new Map<string, DependencyGraphSnapshot['nodes'][number]>();
      const edges = new Map<string, DependencyGraphSnapshot['edges'][number]>();
      let cursor: string | undefined;
      let watermark = previous.source.watermark;
      let hasNext = true;
      let pages = 0;
      let dependencyTruncated = false;
      while (hasNext && pages < DEPENDENCY_GRAPH_MAX_PAGES) {
        const page = await this.source.page(repo, cursor);
        pages += 1;
        if (!full && page.rootIssueOldestUpdatedAt && Date.parse(page.rootIssueOldestUpdatedAt) < cutoff) {
          // Include this page's entries newer than the overlap boundary, then stop. Updating
          // slightly older entries too is safe and makes the watermark boundary replayable.
          if (page.rootIssueNewestUpdatedAt && Date.parse(page.rootIssueNewestUpdatedAt) < cutoff) break;
        }
        for (const node of page.nodes) {
          // Keep every node returned on the overlap page, including older linked endpoints.
          // Edges are complete only when their repository-local endpoints are present; the small
          // overlap intentionally refreshes a few extra rows to keep replay idempotent.
          const existing = nodes.get(node.id);
          if (!existing || ('labels' in node && node.labels.length >= ('labels' in existing ? existing.labels.length : 0))) nodes.set(node.id, node);
        }
        for (const edge of page.edges) edges.set(edge.id, edge);
        if (page.watermark && (!watermark || page.watermark > watermark)) watermark = page.watermark;
        dependencyTruncated ||= page.dependencyTruncated;
        cursor = page.nextCursor;
        hasNext = page.hasNextPage;
        if (!full && page.rootIssueOldestUpdatedAt && Date.parse(page.rootIssueOldestUpdatedAt) < cutoff) break;
      }
      const pageLimitReached = hasNext && pages >= DEPENDENCY_GRAPH_MAX_PAGES;
      const complete = !pageLimitReached && !dependencyTruncated;
      const warning = dependencyTruncated
        ? 'GitHub reported more dependencies or labels than this bounded scan fetched; readiness remains unknown until the complete graph is available.'
        : pageLimitReached
          ? `GitHub scan reached the ${DEPENDENCY_GRAPH_MAX_PAGES}-page safety limit; the local projection is incomplete.`
          : undefined;
      const revision = this.store.applySync({
        repository: repo.key,
        nodes: [...nodes.values()],
        edges: [...edges.values()],
        full,
        complete,
        watermark,
        status: complete ? 'fresh' : 'unknown',
        ...(warning ? { warning } : {}),
      });
      return {
        repository: repo.key,
        revision,
        status: complete ? 'fresh' : 'unknown',
        full,
        complete,
        nodesReceived: nodes.size,
        edgesReceived: edges.size,
        ...(warning ? { warning } : {}),
      };
    } catch (error) {
      const warning = safeReason(error);
      repository ??= this.lastRepository;
      if (repository) {
        const previous = this.store.readSnapshot(repository);
        const status = previous.revision > 0 ? 'stale' : 'offline';
        this.store.setUnavailable(repository, status, warning);
        const unavailable = this.store.readSnapshot(repository);
        return {
          repository,
          revision: unavailable.revision,
          status,
          full: false,
          complete: false,
          nodesReceived: 0,
          edgesReceived: 0,
          warning,
        };
      }
      throw new Error(warning);
    }
  }

  close(): void {
    this.store.close();
  }
}

export function createDependencyGraphService(repoRoot: string, options?: ConstructorParameters<typeof DependencyGraphService>[1]): DependencyGraphService {
  return new DependencyGraphService(repoRoot, options);
}
