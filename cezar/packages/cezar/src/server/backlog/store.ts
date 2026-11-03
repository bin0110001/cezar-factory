import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from '../../paths.ts';
import { decodeBacklogMetadata, upsertBacklogMetadata, type BacklogMetadata } from './github-metadata.ts';
import { migrateFromLabels } from './migrate.ts';
import {
  DEFAULT_FIELDS, DEFAULT_READY_POLICY, EDITABLE_FIELDS, compareBacklog, isAllowedTransition, readyEntryBlockers, recordKey,
  validateFields, type BacklogFields, type BacklogLane, type BacklogRecord, type EditableField, type FieldProvenance, type FieldSource,
  type ReadyPolicy,
} from './model.ts';
import { threeWayMerge, type FieldConflict } from './sync.ts';
import { compareRank, rankBetween } from './rank.ts';

interface SqlStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  close(): void;
}
interface SqliteConstructor { new(path: string): SqlDatabase }

const require = createRequire(import.meta.url);
export const BACKLOG_SCHEMA_VERSION = 1;
export const LOCAL_ORIGIN = 'cezar';

export type BacklogErrorCode = 'not_found' | 'stale_revision' | 'invalid_field' | 'invalid_transition' | 'not_ready' | 'human_owned' | 'stale_remote' | 'no_conflict';
export class BacklogError extends Error {
  constructor(readonly code: BacklogErrorCode, message: string) { super(message); this.name = 'BacklogError'; }
}

export interface WriteOptions {
  actor: string;
  source?: FieldSource;
  reason?: string;
  /** Optimistic concurrency: the record revision the caller last read. */
  expectedRevision?: number;
  now?: string;
  readyPolicy?: ReadyPolicy;
}

export interface AuditEntry {
  cursor: number; key: string; revision: number; actor: string; source: FieldSource | 'sync';
  reason: string | null; before: Partial<BacklogFields>; after: Partial<BacklogFields>; createdAt: string;
}

export interface OpenConflict extends FieldConflict { id: number; key: string; createdAt: string }

export type RemoteOutcome =
  | { outcome: 'echo' | 'unchanged' | 'no-remote-metadata' }
  | { outcome: 'merged'; applied: EditableField[]; toPush: EditableField[]; conflicts: EditableField[] };

export interface PendingPush { key: string; fields: EditableField[]; expectedRemoteVersion: number; metadata: BacklogMetadata }

function dbPath(options: { home?: string; path?: string }): string {
  return options.path ?? resolve(options.home ?? cezarHomeDir(), 'backlog', 'backlog.sqlite');
}

/** Durable per-host projection of the GitHub-authoritative backlog fields. No second issue database. */
export class BacklogStore {
  private readonly db: SqlDatabase;

  constructor(options: { home?: string; path?: string; env?: NodeJS.ProcessEnv } = {}) {
    const path = dbPath(options);
    const env = options.env ?? process.env;
    if (options.home === undefined && options.path === undefined) {
      assertCezarHomeWriteIsSandboxed(path, env);
      if (env.VITEST && !env.CEZ_HOME) throw new Error('backlog test store requires a sandboxed CEZ_HOME');
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const Database = require('better-sqlite3') as SqliteConstructor;
    this.db = new Database(path);
    if (path !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
  }

  close(): void { this.db.close(); }

  private migrate(): void {
    const current = Number(this.db.pragma('user_version', { simple: true }));
    if (current > BACKLOG_SCHEMA_VERSION) throw new Error(`backlog database schema ${current} is newer than supported ${BACKLOG_SCHEMA_VERSION}`);
    if (current === BACKLOG_SCHEMA_VERSION) return;
    if (current !== 0) throw new Error(`no backlog migration from schema ${current}`);
    this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE backlog_records (
        key TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        fields TEXT NOT NULL,
        base_fields TEXT,
        policy_constraints TEXT NOT NULL DEFAULT '[]',
        issue_state TEXT NOT NULL DEFAULT 'open',
        archived INTEGER NOT NULL DEFAULT 0,
        provenance TEXT NOT NULL DEFAULT '{}',
        revision INTEGER NOT NULL,
        remote_version INTEGER NOT NULL DEFAULT 0,
        last_write_id TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX backlog_records_repo ON backlog_records(repository);
      CREATE TABLE backlog_audit (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        revision INTEGER NOT NULL,
        actor TEXT NOT NULL,
        source TEXT NOT NULL,
        reason TEXT,
        before TEXT NOT NULL,
        after TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX backlog_audit_key ON backlog_audit(key, cursor);
      CREATE TABLE backlog_conflicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        field TEXT NOT NULL,
        base TEXT,
        local TEXT,
        remote TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL
      );
      CREATE INDEX backlog_conflicts_open ON backlog_conflicts(key, status);
      PRAGMA user_version = ${BACKLOG_SCHEMA_VERSION};
      COMMIT;
    `);
  }

  // ---- reads -------------------------------------------------------------------------------

  private toRecord(row: Record<string, unknown>): BacklogRecord {
    const fields = JSON.parse(row.fields as string) as BacklogFields;
    return {
      ...DEFAULT_FIELDS, ...fields,
      repository: row.repository as string,
      issueNumber: row.issue_number as number,
      policyConstraints: JSON.parse(row.policy_constraints as string) as string[],
      issueState: row.issue_state as 'open' | 'closed',
      archived: row.archived === 1,
      provenance: JSON.parse(row.provenance as string) as BacklogRecord['provenance'],
      revision: row.revision as number,
      updatedAt: row.updated_at as string,
    };
  }

  get(repository: string, issueNumber: number): BacklogRecord | null {
    const row = this.db.prepare('SELECT * FROM backlog_records WHERE key = ?').get(recordKey(repository, issueNumber));
    return row ? this.toRecord(row) : null;
  }

  /** Records in deterministic display order (expedite, priority, rank, identity). */
  list(filter: { repository?: string; lane?: BacklogLane; includeArchived?: boolean } = {}): BacklogRecord[] {
    const rows = filter.repository
      ? this.db.prepare('SELECT * FROM backlog_records WHERE repository = ?').all(filter.repository.toLowerCase())
      : this.db.prepare('SELECT * FROM backlog_records').all();
    return rows.map((r) => this.toRecord(r))
      .filter((r) => (filter.includeArchived || !r.archived) && (!filter.lane || r.lane === filter.lane))
      .sort(compareBacklog);
  }

  audit(repository: string, issueNumber: number): AuditEntry[] {
    return this.db.prepare('SELECT * FROM backlog_audit WHERE key = ? ORDER BY cursor').all(recordKey(repository, issueNumber)).map((r) => ({
      cursor: r.cursor as number, key: r.key as string, revision: r.revision as number, actor: r.actor as string,
      source: r.source as AuditEntry['source'], reason: (r.reason as string | null) ?? null,
      before: JSON.parse(r.before as string) as Partial<BacklogFields>, after: JSON.parse(r.after as string) as Partial<BacklogFields>,
      createdAt: r.created_at as string,
    }));
  }

  openConflicts(repository?: string, issueNumber?: number): OpenConflict[] {
    const rows = repository && issueNumber
      ? this.db.prepare("SELECT * FROM backlog_conflicts WHERE status = 'open' AND key = ? ORDER BY id").all(recordKey(repository, issueNumber))
      : this.db.prepare("SELECT * FROM backlog_conflicts WHERE status = 'open' ORDER BY id").all();
    return rows.map((r) => ({
      id: r.id as number, key: r.key as string, createdAt: r.created_at as string, field: r.field as EditableField,
      base: JSON.parse(r.base as string), local: JSON.parse(r.local as string), remote: JSON.parse(r.remote as string),
    }));
  }

  // ---- writes ------------------------------------------------------------------------------

  /**
   * Idempotently create a record from existing labels. An existing record is NEVER modified, so
   * re-running a migration cannot undo a later human edit. Original labels are left untouched
   * on the issue, which is the rollback path: delete the projection and re-run.
   */
  ensureFromLabels(repository: string, issueNumber: number, input: { labels: readonly string[]; issueState: 'open' | 'closed'; archived?: boolean }, options: { now?: string } = {}): { record: BacklogRecord; created: boolean; warnings: string[] } {
    const key = recordKey(repository, issueNumber);
    const existing = this.get(repository, issueNumber);
    if (existing) return { record: existing, created: false, warnings: [] };
    const migration = migrateFromLabels(input.labels, input.issueState);
    const now = options.now ?? new Date().toISOString();
    const fields: BacklogFields = { ...DEFAULT_FIELDS, ...migration.fields };
    if (!migration.fields.lane) fields.lane = input.issueState === 'closed' ? 'Done' : 'Inbox';
    const provenance: BacklogRecord['provenance'] = {};
    for (const f of ['basePriority', 'lane'] as const) {
      if (migration.fields[f] !== undefined) provenance[f] = { source: 'migrated', actor: 'label-migration', at: now, reason: `from labels: ${migration.sourceLabels.join(', ')}` };
    }
    this.db.prepare(`INSERT INTO backlog_records (key, repository, issue_number, fields, base_fields, issue_state, archived, provenance, revision, updated_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 1, ?)`).run(key, repository.toLowerCase(), issueNumber, JSON.stringify(fields), input.issueState, input.archived ? 1 : 0, JSON.stringify(provenance), now);
    this.insertAudit(key, 1, 'label-migration', 'migrated', 'migrated from labels', {}, fields, now);
    return { record: this.get(repository, issueNumber)!, created: true, warnings: migration.warnings };
  }

  /** Apply a validated, optimistic, audited field edit. */
  update(repository: string, issueNumber: number, patch: Partial<BacklogFields>, options: WriteOptions): BacklogRecord {
    const key = recordKey(repository, issueNumber);
    const run = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM backlog_records WHERE key = ?').get(key);
      if (!row) throw new BacklogError('not_found', `no backlog record for ${key}`);
      const record = this.toRecord(row);
      if (options.expectedRevision !== undefined && options.expectedRevision !== record.revision) {
        throw new BacklogError('stale_revision', `${key} is at revision ${record.revision}, caller read ${options.expectedRevision}`);
      }
      const errors = validateFields(patch);
      if (errors.length > 0) throw new BacklogError('invalid_field', errors.join('; '));
      const source = options.source ?? 'human';
      const now = options.now ?? new Date().toISOString();
      const next: BacklogFields = this.fieldsOf(record);
      const before: Partial<BacklogFields> = {};
      const after: Partial<BacklogFields> = {};
      const provenance = { ...record.provenance };
      for (const field of EDITABLE_FIELDS) {
        if (!(field in patch) || patch[field] === undefined || patch[field] === record[field]) continue;
        if (source === 'inferred' && provenance[field]?.source === 'human') {
          throw new BacklogError('human_owned', `${field} was set by a human and cannot be overwritten by inference`);
        }
        (before as Record<string, unknown>)[field] = record[field];
        (after as Record<string, unknown>)[field] = patch[field];
        (next as unknown as Record<string, unknown>)[field] = patch[field];
        provenance[field] = { source, actor: options.actor, at: now, ...(options.reason ? { reason: options.reason } : {}) } satisfies FieldProvenance;
      }
      if (Object.keys(after).length === 0) return record;
      if (next.lane !== record.lane) {
        if (!isAllowedTransition(record.lane, next.lane)) throw new BacklogError('invalid_transition', `lane ${record.lane} -> ${next.lane} is not allowed`);
        if (next.lane === 'Ready') {
          const blockers = readyEntryBlockers({ ...record, ...next }, options.readyPolicy ?? DEFAULT_READY_POLICY);
          if (blockers.length > 0) throw new BacklogError('not_ready', `cannot enter Ready: ${blockers.join('; ')}`);
        }
      }
      const revision = record.revision + 1;
      this.db.prepare('UPDATE backlog_records SET fields = ?, provenance = ?, revision = ?, updated_at = ? WHERE key = ?')
        .run(JSON.stringify(next), JSON.stringify(provenance), revision, now, key);
      this.insertAudit(key, revision, options.actor, source, options.reason ?? null, before, after, now);
      return this.get(repository, issueNumber)!;
    });
    return run();
  }

  /** Place an issue between two neighbours (either may be null = list end). Neighbours must share the repository scope. */
  placeBetween(repository: string, issueNumber: number, beforeNumber: number | null, afterNumber: number | null, options: WriteOptions): BacklogRecord {
    const before = beforeNumber === null ? null : this.get(repository, beforeNumber)?.backlogRank ?? null;
    const after = afterNumber === null ? null : this.get(repository, afterNumber)?.backlogRank ?? null;
    return this.update(repository, issueNumber, { backlogRank: rankBetween(before, after) }, options);
  }

  /**
   * Break rank ties (e.g. after two writers independently chose the same rank): equal ranks keep
   * identity order and every later duplicate is re-ranked just after its predecessor. Deterministic.
   */
  normalizeRanks(repository: string, options: WriteOptions): number {
    const ranked = this.list({ repository, includeArchived: true }).filter((r) => r.backlogRank !== null)
      .sort((a, b) => compareRank(a.backlogRank, b.backlogRank) || a.issueNumber - b.issueNumber);
    let changed = 0;
    let last: string | null = null;
    for (let i = 0; i < ranked.length; i++) {
      const rank = ranked[i]!.backlogRank!;
      if (last === null || rank > last) { last = rank; continue; }
      const next = ranked.slice(i + 1).map((r) => r.backlogRank!).find((r) => r > last!) ?? null;
      last = rankBetween(last, next);
      this.update(repository, ranked[i]!.issueNumber, { backlogRank: last }, { ...options, reason: options.reason ?? 'rank collision' });
      changed++;
    }
    return changed;
  }

  setIssueState(repository: string, issueNumber: number, state: { issueState?: 'open' | 'closed'; archived?: boolean }, now = new Date().toISOString()): BacklogRecord {
    const key = recordKey(repository, issueNumber);
    const record = this.get(repository, issueNumber);
    if (!record) throw new BacklogError('not_found', `no backlog record for ${key}`);
    this.db.prepare('UPDATE backlog_records SET issue_state = ?, archived = ?, updated_at = ? WHERE key = ?')
      .run(state.issueState ?? record.issueState, (state.archived ?? record.archived) ? 1 : 0, now, key);
    return this.get(repository, issueNumber)!;
  }

  // ---- GitHub reconciliation ---------------------------------------------------------------

  private fieldsOf(record: BacklogRecord): BacklogFields {
    const out = {} as Record<string, unknown>;
    for (const f of EDITABLE_FIELDS) out[f] = record[f];
    return out as unknown as BacklogFields;
  }

  /**
   * Fold what GitHub currently says into the projection. Our own echoes are ignored; remote-only
   * edits are applied; local-only edits stay queued as a push; edits to the same field on both
   * sides are recorded as open conflicts and never overwrite either side.
   */
  applyRemote(repository: string, issueNumber: number, issueBody: string, options: { now?: string } = {}): RemoteOutcome {
    const key = recordKey(repository, issueNumber);
    const now = options.now ?? new Date().toISOString();
    const run = this.db.transaction((): RemoteOutcome => {
      const row = this.db.prepare('SELECT * FROM backlog_records WHERE key = ?').get(key);
      if (!row) throw new BacklogError('not_found', `no backlog record for ${key}`);
      const record = this.toRecord(row);
      const meta = decodeBacklogMetadata(issueBody);
      if (!meta) return { outcome: 'no-remote-metadata' };
      if (meta.origin === LOCAL_ORIGIN && meta.writeId === row.last_write_id) {
        this.db.prepare('UPDATE backlog_records SET remote_version = MAX(remote_version, ?) WHERE key = ?').run(meta.version, key);
        return { outcome: 'echo' };
      }
      if (meta.version < (row.remote_version as number)) return { outcome: 'unchanged' }; // older than what we already folded in
      const local = this.fieldsOf(record);
      // First contact: no agreed base yet, so the remote is authoritative for fields still at defaults.
      const base = row.base_fields ? JSON.parse(row.base_fields as string) as BacklogFields : { ...DEFAULT_FIELDS };
      const result = threeWayMerge(base, local, meta.fields);
      const nextBase: BacklogFields = { ...base };
      const conflictFields = new Set(result.conflicts.map((c) => c.field));
      for (const f of EDITABLE_FIELDS) if (!conflictFields.has(f) && !result.toPush.includes(f)) (nextBase as unknown as Record<string, unknown>)[f] = meta.fields[f];
      const provenance = { ...record.provenance };
      const before: Partial<BacklogFields> = {}; const after: Partial<BacklogFields> = {};
      for (const f of result.fromRemote) {
        (before as Record<string, unknown>)[f] = local[f]; (after as Record<string, unknown>)[f] = meta.fields[f];
        provenance[f] = { source: 'human', actor: meta.origin, at: meta.updatedAt || now, reason: 'synced from GitHub' };
      }
      let revision = record.revision;
      if (result.fromRemote.length > 0) {
        revision += 1;
        this.insertAudit(key, revision, meta.origin, 'sync', 'applied GitHub edit', before, after, now);
      }
      this.db.prepare('UPDATE backlog_records SET fields = ?, base_fields = ?, provenance = ?, revision = ?, remote_version = ?, updated_at = ? WHERE key = ?')
        .run(JSON.stringify(result.merged), JSON.stringify(nextBase), JSON.stringify(provenance), revision, meta.version, result.fromRemote.length > 0 ? now : record.updatedAt, key);
      for (const c of result.conflicts) {
        const dup = this.db.prepare("SELECT id FROM backlog_conflicts WHERE key = ? AND field = ? AND status = 'open' AND remote = ? AND local = ?")
          .get(key, c.field, JSON.stringify(c.remote), JSON.stringify(c.local));
        if (!dup) this.db.prepare('INSERT INTO backlog_conflicts (key, field, base, local, remote, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(key, c.field, JSON.stringify(c.base), JSON.stringify(c.local), JSON.stringify(c.remote), now);
      }
      if (result.fromRemote.length === 0 && result.toPush.length === 0 && result.conflicts.length === 0) return { outcome: 'unchanged' };
      return { outcome: 'merged', applied: result.fromRemote, toPush: result.toPush, conflicts: result.conflicts.map((c) => c.field) };
    });
    return run();
  }

  /** Local edits not yet on GitHub, with the remote version the write must be based on. Null = in sync. */
  pendingPush(repository: string, issueNumber: number, now = new Date().toISOString()): PendingPush | null {
    const key = recordKey(repository, issueNumber);
    const row = this.db.prepare('SELECT * FROM backlog_records WHERE key = ?').get(key);
    if (!row) return null;
    const record = this.toRecord(row);
    const local = this.fieldsOf(record);
    const base = row.base_fields ? JSON.parse(row.base_fields as string) as BacklogFields : null;
    const conflicted = new Set(this.openConflicts(repository, issueNumber).map((c) => c.field));
    const fields = EDITABLE_FIELDS.filter((f) => !conflicted.has(f) && (base ? local[f] !== base[f] : local[f] !== DEFAULT_FIELDS[f] || record.provenance[f] !== undefined));
    if (fields.length === 0) return null;
    const version = row.remote_version as number;
    return { key, fields, expectedRemoteVersion: version, metadata: { fields: local, version: version + 1, origin: LOCAL_ORIGIN, writeId: randomUUID(), updatedAt: now } };
  }

  /** Render the issue body for a pending push (human text untouched). */
  renderPush(issueBody: string, push: PendingPush): string { return upsertBacklogMetadata(issueBody, push.metadata); }

  /**
   * Record that `push` reached GitHub. Rejected when the remote moved since it was prepared,
   * which forces a fresh applyRemote (and possibly a conflict) before retrying: no blind overwrite.
   */
  markPushed(repository: string, issueNumber: number, push: PendingPush): void {
    const key = recordKey(repository, issueNumber);
    const run = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM backlog_records WHERE key = ?').get(key);
      if (!row) throw new BacklogError('not_found', `no backlog record for ${key}`);
      if ((row.remote_version as number) !== push.expectedRemoteVersion) throw new BacklogError('stale_remote', `${key} remote moved to version ${String(row.remote_version)}; re-sync before pushing`);
      const base = row.base_fields ? JSON.parse(row.base_fields as string) as BacklogFields : { ...DEFAULT_FIELDS };
      for (const f of push.fields) (base as unknown as Record<string, unknown>)[f] = push.metadata.fields[f];
      this.db.prepare('UPDATE backlog_records SET base_fields = ?, remote_version = ?, last_write_id = ? WHERE key = ?')
        .run(JSON.stringify(base), push.metadata.version, push.metadata.writeId, key);
    });
    run();
  }

  /** Resolve one open conflict explicitly. `local` re-queues our value for push; `remote` adopts GitHub's. */
  resolveConflict(repository: string, issueNumber: number, field: EditableField, keep: 'local' | 'remote', options: { actor: string; now?: string }): BacklogRecord {
    const key = recordKey(repository, issueNumber);
    const now = options.now ?? new Date().toISOString();
    const run = this.db.transaction(() => {
      const conflict = this.openConflicts(repository, issueNumber).find((c) => c.field === field);
      if (!conflict) throw new BacklogError('no_conflict', `no open conflict on ${field} for ${key}`);
      const row = this.db.prepare('SELECT * FROM backlog_records WHERE key = ?').get(key)!;
      const record = this.toRecord(row);
      const base = JSON.parse(row.base_fields as string) as BacklogFields;
      (base as unknown as Record<string, unknown>)[field] = conflict.remote; // remote is now the agreed base either way
      let revision = record.revision;
      if (keep === 'remote') {
        const fields = this.fieldsOf(record);
        const before = { [field]: fields[field] }; (fields as unknown as Record<string, unknown>)[field] = conflict.remote;
        revision += 1;
        this.db.prepare('UPDATE backlog_records SET fields = ?, revision = ?, updated_at = ? WHERE key = ?').run(JSON.stringify(fields), revision, now, key);
        this.insertAudit(key, revision, options.actor, 'human', `conflict on ${field}: kept remote`, before, { [field]: conflict.remote }, now);
      }
      this.db.prepare('UPDATE backlog_records SET base_fields = ? WHERE key = ?').run(JSON.stringify(base), key);
      this.db.prepare("UPDATE backlog_conflicts SET status = 'resolved' WHERE id = ?").run(conflict.id);
      return this.get(repository, issueNumber)!;
    });
    return run();
  }

  private insertAudit(key: string, revision: number, actor: string, source: string, reason: string | null, before: unknown, after: unknown, now: string): void {
    this.db.prepare('INSERT INTO backlog_audit (key, revision, actor, source, reason, before, after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(key, revision, actor, source, reason, JSON.stringify(before), JSON.stringify(after), now);
  }
}
