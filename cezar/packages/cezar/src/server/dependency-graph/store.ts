import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { cezarHomeDir, assertCezarHomeWriteIsSandboxed } from '../../paths.ts';
import {
  decisionRecordSchema,
  dependencyGraphEdgeSchema,
  dependencyGraphNodeSchema,
  dependencyGraphSnapshotSchema,
  isDependencyNodeInRepository,
  validateDependencyGraphSnapshot,
  type DecisionRecord,
  type DependencyGraphEdge,
  type DependencyGraphNode,
  type DependencyGraphSnapshot,
  type GithubRepositoryKey,
} from '@open-mercato/cezar-contract';

interface SqlStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  pragma(source: string): unknown;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  close(): void;
}
interface SqliteConstructor { new(path: string): SqlDatabase }

const require = createRequire(import.meta.url);
const STORE_SCHEMA_VERSION = 1;

export interface DependencyGraphSyncWrite {
  repository: GithubRepositoryKey;
  nodes: DependencyGraphNode[];
  edges: DependencyGraphEdge[];
  decisions?: DecisionRecord[];
  full: boolean;
  complete: boolean;
  watermark?: string;
  status: 'fresh' | 'stale' | 'offline' | 'unknown';
  warning?: string;
  now?: string;
}

export interface DependencyGraphAuditEvent {
  cursor: number;
  revision: number;
  kind: string;
  entityId: string;
  actor: string;
  payload: unknown;
  createdAt: string;
}

function repositoryDbPath(repoRoot: string, home?: string): string {
  const root = resolve(repoRoot);
  if (!isAbsolute(root)) throw new Error('dependency graph repoRoot must be absolute');
  const key = createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 32);
  return resolve(home ?? cezarHomeDir(), 'dependency-intelligence', `${key}.sqlite`);
}

function asString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`invalid dependency graph ${name}`);
  return value;
}

function parseJson<T>(value: unknown, parse: (value: unknown) => T, name: string): T {
  try { return parse(JSON.parse(asString(value, name))); }
  catch (error) { throw new Error(`dependency graph ${name} validation failed: ${error instanceof Error ? error.message : String(error)}`); }
}

function rowNumber(row: Record<string, unknown> | undefined, key: string, fallback = 0): number {
  return row && typeof row[key] === 'number' ? row[key] as number : fallback;
}

/** Durable, versioned per-repository SQLite projection. GitHub remains authoritative and rebuildable. */
export class DependencyGraphStore {
  private readonly db: SqlDatabase;
  private closed = false;

  constructor(repoRoot: string, options: { home?: string; env?: NodeJS.ProcessEnv } = {}) {
    const path = repositoryDbPath(repoRoot, options.home);
    const env = options.env ?? process.env;
    if (options.home === undefined) assertCezarHomeWriteIsSandboxed(path, env);
    if (env.VITEST && options.home === undefined && !env.CEZ_HOME) {
      throw new Error('dependency graph test store requires a sandboxed CEZ_HOME');
    }
    mkdirSync(resolve(path, '..'), { recursive: true });
    const DatabaseSync = require('better-sqlite3') as SqliteConstructor;
    this.db = new DatabaseSync(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
  }

  private migrate(): void {
    const current = Number(this.db.pragma('user_version') as number);
    if (current > STORE_SCHEMA_VERSION) throw new Error(`dependency graph database schema ${current} is newer than supported ${STORE_SCHEMA_VERSION}`);
    if (current === STORE_SCHEMA_VERSION) return;
    if (current !== 0) throw new Error(`no dependency graph migration from schema ${current}`);
    this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS dependency_graph_meta (
        repository TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 0,
        source_status TEXT NOT NULL DEFAULT 'unknown',
        last_successful_sync_at TEXT,
        watermark TEXT,
        warning TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dependency_graph_snapshots (
        repository TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        source_json TEXT NOT NULL,
        PRIMARY KEY (repository, revision)
      );
      CREATE TABLE IF NOT EXISTS dependency_graph_nodes (
        repository TEXT NOT NULL,
        node_id TEXT NOT NULL,
        valid_from_revision INTEGER NOT NULL,
        valid_to_revision INTEGER,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sync_seen TEXT NOT NULL,
        PRIMARY KEY (repository, node_id, valid_from_revision)
      );
      CREATE INDEX IF NOT EXISTS dependency_graph_nodes_current ON dependency_graph_nodes(repository, node_id, valid_to_revision);
      CREATE INDEX IF NOT EXISTS dependency_graph_nodes_revision ON dependency_graph_nodes(repository, valid_from_revision, valid_to_revision, node_id);
      CREATE TABLE IF NOT EXISTS dependency_graph_edges (
        repository TEXT NOT NULL,
        edge_id TEXT NOT NULL,
        valid_from_revision INTEGER NOT NULL,
        valid_to_revision INTEGER,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        origin TEXT NOT NULL,
        authority TEXT NOT NULL,
        payload TEXT NOT NULL,
        sync_seen TEXT NOT NULL,
        PRIMARY KEY (repository, edge_id, valid_from_revision)
      );
      CREATE INDEX IF NOT EXISTS dependency_graph_edges_current ON dependency_graph_edges(repository, edge_id, valid_to_revision);
      CREATE INDEX IF NOT EXISTS dependency_graph_edges_from ON dependency_graph_edges(repository, from_id, kind, valid_from_revision, valid_to_revision);
      CREATE INDEX IF NOT EXISTS dependency_graph_edges_to ON dependency_graph_edges(repository, to_id, kind, valid_from_revision, valid_to_revision);
      CREATE TABLE IF NOT EXISTS dependency_graph_decisions (
        repository TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        valid_from_revision INTEGER NOT NULL,
        valid_to_revision INTEGER,
        decision_revision INTEGER NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repository, decision_id, valid_from_revision)
      );
      CREATE INDEX IF NOT EXISTS dependency_graph_decisions_current ON dependency_graph_decisions(repository, decision_id, valid_to_revision);
      CREATE TABLE IF NOT EXISTS dependency_graph_events (
        event_id TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        revision INTEGER NOT NULL,
        kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS dependency_graph_events_repo_revision ON dependency_graph_events(repository, revision DESC);
      PRAGMA user_version = ${STORE_SCHEMA_VERSION};
      COMMIT;
    `);
  }

  applySync(input: DependencyGraphSyncWrite): number {
    this.assertOpen();
    const now = input.now ?? new Date().toISOString();
    const nodes = input.nodes.map((node) => dependencyGraphNodeSchema.parse(node));
    const edges = input.edges.map((edge) => dependencyGraphEdgeSchema.parse(edge));
    const decisions = (input.decisions ?? []).map((decision) => decisionRecordSchema.parse(decision));
    const nodeIds = new Set(nodes.map((node) => node.id));
    for (const edge of edges) {
      if (!nodeIds.has(edge.from) && isDependencyNodeInRepository(edge.from, input.repository)) throw new Error(`sync omitted local prerequisite ${edge.from}`);
      if (!nodeIds.has(edge.to) && isDependencyNodeInRepository(edge.to, input.repository)) throw new Error(`sync omitted local dependent ${edge.to}`);
    }
    const syncId = randomUUID();
    const tx = this.db.transaction(() => {
      const previous = this.db.prepare('SELECT revision,last_successful_sync_at,watermark FROM dependency_graph_meta WHERE repository=?').get(input.repository);
      const revision = rowNumber(previous, 'revision') + 1;
      const lastSuccessfulSyncAt = input.complete ? now : (typeof previous?.last_successful_sync_at === 'string' ? previous.last_successful_sync_at : null);
      this.db.prepare(`INSERT INTO dependency_graph_meta (repository,revision,source_status,last_successful_sync_at,watermark,warning,updated_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(repository) DO UPDATE SET revision=excluded.revision,source_status=excluded.source_status,
        last_successful_sync_at=excluded.last_successful_sync_at,watermark=excluded.watermark,warning=excluded.warning,updated_at=excluded.updated_at`)
        .run(input.repository, revision, input.status, lastSuccessfulSyncAt, input.watermark ?? previous?.watermark ?? null, input.warning ?? null, now);

      if (input.full && input.complete) {
        this.db.prepare('UPDATE dependency_graph_nodes SET sync_seen=? WHERE repository=? AND valid_to_revision IS NULL').run(`expired:${syncId}`, input.repository);
        this.db.prepare('UPDATE dependency_graph_edges SET sync_seen=? WHERE repository=? AND valid_to_revision IS NULL').run(`expired:${syncId}`, input.repository);
      }
      for (const node of nodes) this.upsertNode(input.repository, node, revision, syncId);

      if (input.complete && !input.full) {
        const incoming = new Set(edges.map((edge) => edge.id));
        const staleEdges = this.db.prepare(`SELECT edge_id,payload FROM dependency_graph_edges WHERE repository=? AND valid_to_revision IS NULL
          AND origin='github-native' AND (from_id IN (${placeholders(nodes.length)}) OR to_id IN (${placeholders(nodes.length)}))`)
          .all(input.repository, ...nodes.map((node) => node.id), ...nodes.map((node) => node.id));
        for (const edge of staleEdges) {
          const edgeId = asString(edge.edge_id, 'edge id');
          if (!incoming.has(edgeId)) this.closeEdgeVersion(input.repository, edgeId, revision, now, 'edge-tombstone');
        }
      }
      for (const edge of edges) this.upsertEdge(input.repository, edge, revision, syncId);
      if (input.full && input.complete) {
        const absentNodes = this.db.prepare('SELECT node_id,payload FROM dependency_graph_nodes WHERE repository=? AND valid_to_revision IS NULL AND sync_seen<>?').all(input.repository, syncId);
        for (const row of absentNodes) this.closeNodeVersion(input.repository, asString(row.node_id, 'node id'), revision, now, 'node-tombstone');
        const absentEdges = this.db.prepare('SELECT edge_id,payload FROM dependency_graph_edges WHERE repository=? AND valid_to_revision IS NULL AND sync_seen<>?').all(input.repository, syncId);
        for (const row of absentEdges) this.closeEdgeVersion(input.repository, asString(row.edge_id, 'edge id'), revision, now, 'edge-tombstone');
      }
      for (const decision of decisions) this.upsertDecision(input.repository, decision, revision, now);

      const source = {
        status: input.status,
        ...(lastSuccessfulSyncAt ? { lastSuccessfulSyncAt } : {}),
        ...(input.watermark ?? (typeof previous?.watermark === 'string' ? previous.watermark : undefined)
          ? { watermark: input.watermark ?? previous?.watermark as string } : {}),
        ...(input.warning ? { warning: input.warning } : {}),
      };
      this.writeSnapshot(input.repository, revision, now, source);
      this.recordEvent(input.repository, revision, 'sync', input.repository, 'github-sync', {
        full: input.full, complete: input.complete, nodes: nodes.length, edges: edges.length, status: input.status,
      }, now);
      return revision;
    });
    const revision = tx();
    this.readSnapshot(input.repository, revision);
    return revision;
  }

  setUnavailable(repository: GithubRepositoryKey, status: 'stale' | 'offline' | 'unknown', warning: string, now = new Date().toISOString()): void {
    this.assertOpen();
    const tx = this.db.transaction(() => {
      const previous = this.db.prepare('SELECT revision,last_successful_sync_at,watermark FROM dependency_graph_meta WHERE repository=?').get(repository);
      const revision = rowNumber(previous, 'revision') + 1;
      this.db.prepare(`INSERT INTO dependency_graph_meta (repository,revision,source_status,last_successful_sync_at,watermark,warning,updated_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(repository) DO UPDATE SET revision=excluded.revision,source_status=excluded.source_status,
        warning=excluded.warning,updated_at=excluded.updated_at`).run(repository, revision, status,
          previous?.last_successful_sync_at ?? null, previous?.watermark ?? null, warning.slice(0, 1_000), now);
      const source = {
        status,
        ...(typeof previous?.last_successful_sync_at === 'string' ? { lastSuccessfulSyncAt: previous.last_successful_sync_at } : {}),
        ...(typeof previous?.watermark === 'string' ? { watermark: previous.watermark } : {}),
        warning: warning.slice(0, 1_000),
      };
      this.writeSnapshot(repository, revision, now, source);
      this.recordEvent(repository, revision, 'source-unavailable', repository, 'github-sync', { status, warning: warning.slice(0, 1_000) }, now);
    });
    tx();
  }

  readSnapshot(repository: GithubRepositoryKey, revision?: number): DependencyGraphSnapshot {
    this.assertOpen();
    const meta = this.db.prepare('SELECT revision,updated_at FROM dependency_graph_meta WHERE repository=?').get(repository);
    const targetRevision = revision ?? rowNumber(meta, 'revision');
    const snapshotRow = this.db.prepare('SELECT created_at,source_json FROM dependency_graph_snapshots WHERE repository=? AND revision=?').get(repository, targetRevision);
    if (!snapshotRow && targetRevision !== 0) throw new Error(`dependency graph snapshot ${targetRevision} is unavailable`);
    const source = snapshotRow ? parseJson(snapshotRow.source_json, (value) => value as DependencyGraphSnapshot['source'], 'snapshot source') : { status: 'unknown' as const };
    const nodes = this.db.prepare(`SELECT payload FROM dependency_graph_nodes WHERE repository=? AND valid_from_revision<=?
      AND (valid_to_revision IS NULL OR valid_to_revision>?) ORDER BY node_id`).all(repository, targetRevision, targetRevision)
      .map((row) => parseJson(row.payload, (value) => dependencyGraphNodeSchema.parse(value), 'node'));
    const edges = this.db.prepare(`SELECT payload FROM dependency_graph_edges WHERE repository=? AND valid_from_revision<=?
      AND (valid_to_revision IS NULL OR valid_to_revision>?) ORDER BY edge_id`).all(repository, targetRevision, targetRevision)
      .map((row) => parseJson(row.payload, (value) => dependencyGraphEdgeSchema.parse(value), 'edge'));
    const decisions = this.db.prepare(`SELECT payload FROM dependency_graph_decisions WHERE repository=? AND valid_from_revision<=?
      AND (valid_to_revision IS NULL OR valid_to_revision>?) ORDER BY decision_id`).all(repository, targetRevision, targetRevision)
      .map((row) => parseJson(row.payload, (value) => decisionRecordSchema.parse(value), 'decision'));
    const decisionNodes = decisions.map((decision) => ({
      kind: 'decision' as const, id: decision.id, repository: decision.repository,
      title: decision.question, state: decision.state,
      requiredAuthorization: decision.requiredAuthorization, revision: decision.revision,
      updatedAt: decision.updatedAt,
    }));
    const result = dependencyGraphSnapshotSchema.parse({
      schemaVersion: 1,
      repository,
      revision: targetRevision,
      createdAt: typeof snapshotRow?.created_at === 'string' ? snapshotRow.created_at : typeof meta?.updated_at === 'string' ? meta.updated_at : new Date(0).toISOString(),
      source,
      nodes: [...nodes, ...decisionNodes],
      edges,
      decisions,
    });
    const errors = validateDependencyGraphSnapshot(result);
    if (errors.length) throw new Error(`stored dependency graph is inconsistent: ${errors.slice(0, 10).join('; ')}`);
    return result;
  }

  readSnapshotIndex(repository: GithubRepositoryKey, limit = 100): Array<{ revision: number; createdAt: string }> {
    this.assertOpen();
    const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.db.prepare('SELECT revision,created_at FROM dependency_graph_snapshots WHERE repository=? ORDER BY revision DESC LIMIT ?')
      .all(repository, bounded).map((row) => ({ revision: rowNumber(row, 'revision'), createdAt: asString(row.created_at, 'snapshot timestamp') }));
  }

  writeDecision(repository: GithubRepositoryKey, decision: DecisionRecord, expectedGraphRevision: number, now = new Date().toISOString(), actor = decision.createdBy, audit?: { rationale: string }): number {
    this.assertOpen();
    const parsed = decisionRecordSchema.parse(decision);
    if (parsed.repository !== repository) throw new Error('decision repository does not match graph');
    const tx = this.db.transaction(() => {
      const meta = this.db.prepare('SELECT revision FROM dependency_graph_meta WHERE repository=?').get(repository);
      const currentRevision = rowNumber(meta, 'revision');
      if (currentRevision !== expectedGraphRevision) throw new Error(`dependency graph revision conflict: expected ${expectedGraphRevision}, found ${currentRevision}`);
      const prior = this.db.prepare('SELECT valid_from_revision,decision_revision,payload FROM dependency_graph_decisions WHERE repository=? AND decision_id=? AND valid_to_revision IS NULL').get(repository, parsed.id);
      const currentDecisionRevision = rowNumber(prior, 'decision_revision', -1);
      const previousDecision = prior ? parseJson(prior.payload, (value) => decisionRecordSchema.parse(value), 'decision') : undefined;
      const nextDecision = decisionRecordSchema.parse({ ...parsed,
        ...(previousDecision ? { createdAt: previousDecision.createdAt, createdBy: previousDecision.createdBy } : {}),
        revision: currentDecisionRevision + 1, updatedAt: now });
      const nextGraphRevision = currentRevision + 1;
      if (prior) this.db.prepare('UPDATE dependency_graph_decisions SET valid_to_revision=? WHERE repository=? AND decision_id=? AND valid_from_revision=?')
        .run(nextGraphRevision, repository, parsed.id, prior.valid_from_revision);
      this.db.prepare(`INSERT INTO dependency_graph_decisions (repository,decision_id,valid_from_revision,valid_to_revision,decision_revision,payload,updated_at)
        VALUES (?,?,?,NULL,?,?,?)`).run(repository, parsed.id, nextGraphRevision, nextDecision.revision, JSON.stringify(nextDecision), now);
      const sourceRow = this.db.prepare('SELECT source_json FROM dependency_graph_snapshots WHERE repository=? AND revision=?').get(repository, currentRevision);
      const source = sourceRow ? parseJson(sourceRow.source_json, (value) => value as DependencyGraphSnapshot['source'], 'snapshot source') : { status: 'unknown' as const };
      this.db.prepare(`INSERT INTO dependency_graph_meta (repository,revision,source_status,last_successful_sync_at,watermark,warning,updated_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(repository) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at`)
        .run(repository, nextGraphRevision, source.status,
          source.lastSuccessfulSyncAt ?? null, source.watermark ?? null, source.warning ?? null, now);
      this.writeSnapshot(repository, nextGraphRevision, now, source);
      this.recordEvent(repository, nextGraphRevision, prior ? 'decision-updated' : 'decision-created', parsed.id, actor, {
        previous: previousDecision ?? null,
        current: nextDecision,
        ...(audit ? { rationale: audit.rationale.slice(0, 1_000) } : {}),
      }, now);
      return nextGraphRevision;
    });
    const revision = tx();
    this.readSnapshot(repository, revision);
    return revision;
  }

  readEvents(repository: GithubRepositoryKey, limit = 100, beforeCursor?: number): DependencyGraphAuditEvent[] {
    this.assertOpen();
    const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const rows = beforeCursor === undefined
      ? this.db.prepare(`SELECT rowid,revision,kind,entity_id,actor,payload,created_at FROM dependency_graph_events WHERE repository=? ORDER BY rowid DESC LIMIT ?`).all(repository, boundedLimit)
      : this.db.prepare(`SELECT rowid,revision,kind,entity_id,actor,payload,created_at FROM dependency_graph_events WHERE repository=? AND rowid<? ORDER BY rowid DESC LIMIT ?`).all(repository, beforeCursor, boundedLimit);
    return rows.map((row) => ({
      cursor: rowNumber(row, 'rowid'),
      revision: rowNumber(row, 'revision'),
      kind: asString(row.kind, 'event kind'),
      entityId: asString(row.entity_id, 'event entity id'),
      actor: asString(row.actor, 'event actor'),
      payload: parseJson(row.payload, (value) => value, 'event payload'),
      createdAt: asString(row.created_at, 'event timestamp'),
    }));
  }

  reserveCycleAgentAttempt(repository: GithubRepositoryKey, expectedGraphRevision: number, fingerprint: string, now = new Date().toISOString(), cooldownMs = 24 * 60 * 60_000, maxAttempts = 3): { allowed: boolean; attempt: number; reason?: string } {
    this.assertOpen();
    const tx = this.db.transaction(() => {
      const currentRevision = rowNumber(this.db.prepare('SELECT revision FROM dependency_graph_meta WHERE repository=?').get(repository), 'revision');
      if (currentRevision !== expectedGraphRevision) throw new Error(`dependency graph revision conflict: expected ${expectedGraphRevision}, found ${currentRevision}`);
      const rows = this.db.prepare(`SELECT created_at FROM dependency_graph_events WHERE repository=? AND kind='cycle-agent-attempt' AND entity_id=? ORDER BY rowid DESC`).all(repository, fingerprint);
      if (rows.length >= maxAttempts) return { allowed: false, attempt: rows.length, reason: 'cycle planning attempt budget exhausted' };
      const lastAt = rows[0] && asString(rows[0].created_at, 'cycle agent attempt timestamp');
      if (lastAt && Date.parse(now) - Date.parse(lastAt) < cooldownMs) return { allowed: false, attempt: rows.length, reason: 'cycle planning cooldown is active' };
      const attempt = rows.length + 1;
      this.recordEvent(repository, expectedGraphRevision, 'cycle-agent-attempt', fingerprint, 'dependency-cycle-planner', { attempt, graphRevision: expectedGraphRevision }, now);
      return { allowed: true, attempt };
    });
    return tx();
  }

  reserveDecisionResearchAttempt(repository: GithubRepositoryKey, expectedGraphRevision: number, fingerprint: string, now = new Date().toISOString(), cooldownMs = 6 * 60 * 60_000, maxAttempts = 2): { allowed: boolean; attempt: number; reason?: string } {
    this.assertOpen();
    const tx = this.db.transaction(() => {
      const currentRevision = rowNumber(this.db.prepare('SELECT revision FROM dependency_graph_meta WHERE repository=?').get(repository), 'revision');
      if (currentRevision !== expectedGraphRevision) throw new Error(`dependency graph revision conflict: expected ${expectedGraphRevision}, found ${currentRevision}`);
      const rows = this.db.prepare(`SELECT created_at FROM dependency_graph_events WHERE repository=? AND kind='decision-research-attempt' AND entity_id=? ORDER BY rowid DESC`).all(repository, fingerprint);
      if (rows.length >= maxAttempts) return { allowed: false, attempt: rows.length, reason: 'decision research attempt budget exhausted' };
      const lastAt = rows[0] && asString(rows[0].created_at, 'decision research attempt timestamp');
      if (lastAt && Date.parse(now) - Date.parse(lastAt) < cooldownMs) return { allowed: false, attempt: rows.length, reason: 'decision research cooldown is active' };
      const attempt = rows.length + 1;
      this.recordEvent(repository, expectedGraphRevision, 'decision-research-attempt', fingerprint, 'dependency-research-agent', { attempt, graphRevision: expectedGraphRevision }, now);
      return { allowed: true, attempt };
    });
    return tx();
  }

  recordCycleAgentResult(repository: GithubRepositoryKey, fingerprint: string, outcome: { status: 'started' | 'stale' | 'failed'; runId?: string; reason?: string }, now = new Date().toISOString()): void {
    this.assertOpen();
    const currentRevision = rowNumber(this.db.prepare('SELECT revision FROM dependency_graph_meta WHERE repository=?').get(repository), 'revision');
    this.recordEvent(repository, currentRevision, 'cycle-agent-result', fingerprint, 'dependency-cycle-planner', outcome, now);
  }

  recordDecisionResearchResult(repository: GithubRepositoryKey, fingerprint: string, outcome: { status: 'started' | 'stale' | 'failed'; runId?: string; reason?: string }, now = new Date().toISOString()): void {
    this.assertOpen();
    const currentRevision = rowNumber(this.db.prepare('SELECT revision FROM dependency_graph_meta WHERE repository=?').get(repository), 'revision');
    this.recordEvent(repository, currentRevision, 'decision-research-result', fingerprint, 'dependency-research-agent', outcome, now);
  }

  private upsertNode(repository: GithubRepositoryKey, node: DependencyGraphNode, revision: number, syncId: string): void {
    const current = this.db.prepare('SELECT valid_from_revision,payload FROM dependency_graph_nodes WHERE repository=? AND node_id=? AND valid_to_revision IS NULL').get(repository, node.id);
    const payload = JSON.stringify(node);
    if (current && current.payload === payload) {
      this.db.prepare('UPDATE dependency_graph_nodes SET sync_seen=? WHERE repository=? AND node_id=? AND valid_from_revision=?').run(syncId, repository, node.id, current.valid_from_revision);
      return;
    }
    if (current) this.db.prepare('UPDATE dependency_graph_nodes SET valid_to_revision=? WHERE repository=? AND node_id=? AND valid_from_revision=?')
      .run(revision, repository, node.id, current.valid_from_revision);
    this.db.prepare(`INSERT INTO dependency_graph_nodes (repository,node_id,valid_from_revision,valid_to_revision,kind,payload,updated_at,sync_seen)
      VALUES (?,?,?,NULL,?,?,?,?)`).run(repository, node.id, revision, node.kind, payload, node.updatedAt, syncId);
    if (current) this.recordEvent(repository, revision, 'node-updated', node.id, 'github-sync', { previous: current.payload, current: node }, node.updatedAt);
  }

  private upsertEdge(repository: GithubRepositoryKey, edge: DependencyGraphEdge, revision: number, syncId: string): void {
    const current = this.db.prepare('SELECT valid_from_revision,payload FROM dependency_graph_edges WHERE repository=? AND edge_id=? AND valid_to_revision IS NULL').get(repository, edge.id);
    const payload = JSON.stringify(edge);
    if (current && current.payload === payload) {
      this.db.prepare('UPDATE dependency_graph_edges SET sync_seen=? WHERE repository=? AND edge_id=? AND valid_from_revision=?').run(syncId, repository, edge.id, current.valid_from_revision);
      return;
    }
    if (current) this.db.prepare('UPDATE dependency_graph_edges SET valid_to_revision=? WHERE repository=? AND edge_id=? AND valid_from_revision=?')
      .run(revision, repository, edge.id, current.valid_from_revision);
    this.db.prepare(`INSERT INTO dependency_graph_edges (repository,edge_id,valid_from_revision,valid_to_revision,from_id,to_id,kind,origin,authority,payload,sync_seen)
      VALUES (?,?,?,NULL,?,?,?,?,?,?,?)`).run(repository, edge.id, revision, edge.from, edge.to, edge.kind,
        edge.provenance.origin, edge.provenance.authority, payload, syncId);
    if (current) this.recordEvent(repository, revision, 'edge-updated', edge.id, 'github-sync', { previous: current.payload, current: edge }, edge.updatedAt);
  }

  private upsertDecision(repository: GithubRepositoryKey, decision: DecisionRecord, revision: number, now: string): void {
    const current = this.db.prepare('SELECT valid_from_revision,payload FROM dependency_graph_decisions WHERE repository=? AND decision_id=? AND valid_to_revision IS NULL').get(repository, decision.id);
    const payload = JSON.stringify(decision);
    if (current?.payload === payload) return;
    if (current) this.db.prepare('UPDATE dependency_graph_decisions SET valid_to_revision=? WHERE repository=? AND decision_id=? AND valid_from_revision=?')
      .run(revision, repository, decision.id, current.valid_from_revision);
    this.db.prepare(`INSERT INTO dependency_graph_decisions (repository,decision_id,valid_from_revision,valid_to_revision,decision_revision,payload,updated_at)
      VALUES (?,?,?,NULL,?,?,?)`).run(repository, decision.id, revision, decision.revision, payload, now);
  }

  private closeNodeVersion(repository: GithubRepositoryKey, id: string, revision: number, now: string, eventKind: string): void {
    const current = this.db.prepare('SELECT valid_from_revision,payload FROM dependency_graph_nodes WHERE repository=? AND node_id=? AND valid_to_revision IS NULL').get(repository, id);
    if (!current) return;
    this.db.prepare('UPDATE dependency_graph_nodes SET valid_to_revision=? WHERE repository=? AND node_id=? AND valid_from_revision=?').run(revision, repository, id, current.valid_from_revision);
    this.recordEvent(repository, revision, eventKind, id, 'github-sync', { previous: current.payload }, now);
  }

  private closeEdgeVersion(repository: GithubRepositoryKey, id: string, revision: number, now: string, eventKind: string): void {
    const current = this.db.prepare('SELECT valid_from_revision,payload FROM dependency_graph_edges WHERE repository=? AND edge_id=? AND valid_to_revision IS NULL').get(repository, id);
    if (!current) return;
    this.db.prepare('UPDATE dependency_graph_edges SET valid_to_revision=? WHERE repository=? AND edge_id=? AND valid_from_revision=?').run(revision, repository, id, current.valid_from_revision);
    this.recordEvent(repository, revision, eventKind, id, 'github-sync', { previous: current.payload }, now);
  }

  private writeSnapshot(repository: GithubRepositoryKey, revision: number, createdAt: string, source: DependencyGraphSnapshot['source']): void {
    this.db.prepare('INSERT INTO dependency_graph_snapshots (repository,revision,created_at,source_json) VALUES (?,?,?,?)')
      .run(repository, revision, createdAt, JSON.stringify(source));
  }

  private recordEvent(repository: GithubRepositoryKey, revision: number, kind: string, entityId: string, actor: string, payload: unknown, createdAt: string): void {
    this.db.prepare(`INSERT INTO dependency_graph_events (event_id,repository,revision,kind,entity_id,actor,payload,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(randomUUID(), repository, revision, kind, entityId, actor, JSON.stringify(payload), createdAt);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('dependency graph store is closed');
  }
}

function placeholders(count: number): string {
  if (count < 1) return "SELECT '' WHERE 0";
  return Array.from({ length: count }, () => '?').join(',');
}
