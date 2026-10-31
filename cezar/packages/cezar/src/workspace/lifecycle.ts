import { createHash, randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { cezarHomeDir } from '../paths.ts';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  close(): void;
}
interface SqliteConstructor { new(path: string): Database }

const DatabaseSync = require('better-sqlite3') as SqliteConstructor;

export const LIFECYCLE_STATES = [
  'claimed', 'working', 'validating', 'ready', 'integrating', 'blocked',
  'integrated', 'cleanup_pending', 'closed', 'failed', 'recoverable',
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];
export type WorkspaceOrigin = 'factory-created' | 'adopted';

const FACTORY_WORKSPACE_WORKFLOWS = new Set(['factory-implement', 'factory-review', 'factory-fix-review']);
export function factoryWorkflowParticipatesInWorkspaceLifecycle(name: string): boolean {
  return FACTORY_WORKSPACE_WORKFLOWS.has(name);
}

const TERMINAL = new Set<LifecycleState>(['closed', 'failed']);
const ALLOWED: Record<LifecycleState, LifecycleState[]> = {
  claimed: ['working', 'blocked', 'recoverable', 'failed'],
  working: ['validating', 'ready', 'blocked', 'recoverable', 'failed'],
  validating: ['ready', 'blocked', 'working', 'failed'],
  ready: ['validating', 'integrating', 'blocked', 'failed'],
  integrating: ['integrated', 'ready', 'blocked', 'recoverable', 'failed'],
  blocked: ['working', 'ready', 'failed', 'recoverable'],
  integrated: ['cleanup_pending', 'closed'],
  cleanup_pending: ['closed', 'recoverable'],
  closed: [], failed: ['recoverable', 'closed'], recoverable: ['claimed', 'working', 'ready', 'integrating', 'failed'],
};

export interface LifecycleRecord {
  repoId: string;
  issue: string;
  state: LifecycleState;
  executionId: string;
  ownerId: string;
  fencingToken: number;
  leaseExpiresAt: string;
  workspacePath: string;
  branch: string;
  baseCommit: string;
  origin: WorkspaceOrigin;
  updatedAt: string;
}

function git(cwd: string, args: string[]): Promise<string> {
  return execFileAsync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).then(({ stdout }) => stdout.trim());
}

async function gitTop(cwd: string): Promise<{ root: string; commonDir: string; branch: string; head: string }> {
  const root = await realpath(await git(cwd, ['rev-parse', '--show-toplevel']));
  const commonRaw = await git(root, ['rev-parse', '--git-common-dir']);
  const commonDir = await realpath(isAbsolute(commonRaw) ? commonRaw : resolve(root, commonRaw));
  const [branchRaw, head] = await Promise.all([
    git(root, ['branch', '--show-current']), git(root, ['rev-parse', 'HEAD']),
  ]);
  return { root, commonDir, branch: branchRaw || 'HEAD', head };
}

function localOwner(): string {
  const task = process.env.CEZ_TASK_ID || process.env.CEZ_RUN_ID;
  return task ? `external:${hostname()}:task:${task}` : `external:${hostname()}:${process.pid}`;
}

function openRegistry(commonDir: string, home = cezarHomeDir()): { db: Database; repoId: string } {
  const repoId = createHash('sha256').update(commonDir.toLowerCase()).digest('hex').slice(0, 24);
  const dir = join(home, 'workspace-lifecycle', repoId);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'registry.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const versionRow = db.prepare('PRAGMA user_version').get();
  const version = Number(versionRow?.user_version ?? 0);
  if (version > 3) {
    db.close();
    throw new Error(`Workspace lifecycle registry schema ${version} is newer than this Cezar build supports.`);
  }
  try {
    db.exec('BEGIN IMMEDIATE;');
    db.exec(`
    CREATE TABLE IF NOT EXISTS work_items (
      repo_id TEXT NOT NULL, issue_key TEXT NOT NULL, state TEXT NOT NULL,
      active_execution_id TEXT, next_fence INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (repo_id, issue_key)
    );
    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, issue_key TEXT NOT NULL,
      owner_id TEXT NOT NULL, fencing_token INTEGER NOT NULL,
      state TEXT NOT NULL, lease_expires_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(repo_id, issue_key) REFERENCES work_items(repo_id, issue_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_execution_per_issue
      ON executions(repo_id, issue_key) WHERE active = 1;
    CREATE TABLE IF NOT EXISTS workspaces (
      execution_id TEXT PRIMARY KEY REFERENCES executions(id), repo_id TEXT NOT NULL,
      path TEXT NOT NULL, branch TEXT NOT NULL, base_commit TEXT NOT NULL,
      origin TEXT NOT NULL CHECK(origin IN ('factory-created','adopted')),
      cleanup_policy TEXT NOT NULL CHECK(cleanup_policy IN ('after-integration','never')),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
      repo_id TEXT NOT NULL, issue_key TEXT NOT NULL, execution_id TEXT,
      event_type TEXT NOT NULL, timestamp TEXT NOT NULL, payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id TEXT NOT NULL, issue_key TEXT NOT NULL,
      execution_id TEXT NOT NULL REFERENCES executions(id), target_branch TEXT NOT NULL,
      pull_request TEXT NOT NULL, head_commit TEXT NOT NULL, integrated_commit TEXT NOT NULL,
      validation_result TEXT NOT NULL, integrated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS integration_locks (
      repo_id TEXT NOT NULL, target_branch TEXT NOT NULL, execution_id TEXT NOT NULL,
      lock_token TEXT NOT NULL, lease_expires_at TEXT NOT NULL,
      PRIMARY KEY(repo_id,target_branch)
    );
    CREATE INDEX IF NOT EXISTS event_history ON events(repo_id, issue_key, seq);
    CREATE TABLE IF NOT EXISTS event_outbox (
      event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
      destination TEXT NOT NULL CHECK(destination IN ('langfuse','hindsight')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','failed')),
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
      last_error TEXT, delivered_at TEXT, approved_at TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY(event_id,destination)
    );
    CREATE INDEX IF NOT EXISTS outbox_pending ON event_outbox(status,next_attempt_at);
    CREATE TABLE IF NOT EXISTS outbox_delivery_claims (
      event_id TEXT NOT NULL, destination TEXT NOT NULL, claim_token TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL, PRIMARY KEY(event_id,destination),
      FOREIGN KEY(event_id,destination) REFERENCES event_outbox(event_id,destination) ON DELETE CASCADE
    );
  `);
    if (!db.prepare('PRAGMA table_info(event_outbox)').all().some((column) => column.name === 'approved_at')) {
      db.exec('ALTER TABLE event_outbox ADD COLUMN approved_at TEXT;');
    }
    db.exec('PRAGMA user_version = 3; COMMIT;');
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch { /* preserve the migration error */ }
    db.close();
    throw error;
  }
  return { db, repoId };
}

function event(db: Database, repoId: string, issue: string, executionId: string | null, type: string, payload: unknown): void {
  const eventId = randomUUID();
  const now = new Date().toISOString();
  db.exec('SAVEPOINT lifecycle_event;');
  try {
    db.prepare(`INSERT INTO events(event_id,repo_id,issue_key,execution_id,event_type,timestamp,payload_json)
      VALUES(?,?,?,?,?,?,?)`).run(eventId, repoId, issue, executionId, type, now, JSON.stringify(payload));
    // Queue records in the same SQLite transaction as the lifecycle event. Delivery
    // is deliberately separate so an unavailable telemetry service cannot block work.
    db.prepare(`INSERT INTO event_outbox(event_id,destination,next_attempt_at,created_at)
      SELECT ?, destination, ?, ? FROM (SELECT 'langfuse' destination UNION ALL SELECT 'hindsight')
      WHERE (?='1' AND destination='langfuse') OR (?='1' AND destination='hindsight' AND ?='preflight_repaired')`)
      .run(eventId, now, now,
        process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY && process.env.LANGFUSE_HOST ? '1' : '0',
        process.env.HINDSIGHT_URL && process.env.HINDSIGHT_PROJECT_BANK ? '1' : '0', type);
    db.exec('RELEASE lifecycle_event;');
  } catch (error) {
    try { db.exec('ROLLBACK TO lifecycle_event; RELEASE lifecycle_event;'); } catch { /* preserve the insertion error */ }
    throw error;
  }
}

export async function lifecycleOutbox(options: { cwd?: string; home?: string; limit?: number } = {}): Promise<{
  pending: number; failed: number; delivered: number; next: Array<{ eventId: string; destination: string; type: string; timestamp: string; issue: string; attempts: number }>;
}> {
  const current = await gitTop(options.cwd ?? process.cwd());
  const { db, repoId } = openRegistry(current.commonDir, options.home);
  try {
    const counts = db.prepare(`SELECT status,COUNT(*) count FROM event_outbox o JOIN events e USING(event_id)
      WHERE e.repo_id=? GROUP BY status`).all(repoId);
    const result = { pending: 0, failed: 0, delivered: 0, next: [] as Array<{ eventId: string; destination: string; type: string; timestamp: string; issue: string; attempts: number }> };
    for (const row of counts) result[String(row.status) as 'pending' | 'failed' | 'delivered'] = Number(row.count);
    result.next = db.prepare(`SELECT o.event_id eventId,o.destination,e.event_type type,e.timestamp,e.issue_key issue,o.attempts
      FROM event_outbox o JOIN events e USING(event_id) WHERE e.repo_id=? AND o.status IN ('pending','failed')
      ORDER BY e.seq LIMIT ?`).all(repoId, Math.max(1, Math.min(100, options.limit ?? 20))) as typeof result.next;
    return result;
  } finally { db.close(); }
}

/** Operator approval gates publishing a curated, successfully resolved lesson to Hindsight. */
export async function approveHindsightLesson(options: { eventId: string; cwd?: string; home?: string }): Promise<{ eventId: string; approved: true }> {
  const current = await gitTop(options.cwd ?? process.cwd());
  const { db, repoId } = openRegistry(current.commonDir, options.home);
  try {
    const tx = db.transaction(() => {
      const row = db.prepare(`SELECT o.status,o.approved_at,e.issue_key,e.execution_id,e.event_type FROM event_outbox o
        JOIN events e USING(event_id) WHERE e.repo_id=? AND o.event_id=? AND o.destination='hindsight'`).get(repoId, options.eventId);
      if (!row || row.event_type !== 'preflight_repaired') throw new Error('Hindsight approval requires a queued successful conflict-repair event.');
      if (row.status === 'delivered') throw new Error('This Hindsight lesson was already published.');
      if (row.approved_at && row.status !== 'failed') throw new Error('This Hindsight lesson is already approved and queued.');
      const now = new Date().toISOString();
      db.prepare(`UPDATE event_outbox SET approved_at=?,status='pending',attempts=0,next_attempt_at=?,last_error=NULL
        WHERE event_id=? AND destination='hindsight'`).run(now, now, options.eventId);
      event(db, repoId, String(row.issue_key), row.execution_id === null ? null : String(row.execution_id), 'hindsight_lesson_approved', { eventId: options.eventId, approvedBy: localOwner() });
      return { eventId: options.eventId, approved: true as const };
    });
    return tx();
  } finally { db.close(); }
}

export async function retryLifecycleOutbox(options: { eventId: string; destination: 'langfuse' | 'hindsight'; cwd?: string; home?: string }): Promise<{ eventId: string; destination: string; queued: true }> {
  const current = await gitTop(options.cwd ?? process.cwd());
  const { db, repoId } = openRegistry(current.commonDir, options.home);
  try {
    const tx = db.transaction(() => {
      const row = db.prepare(`SELECT o.status,o.approved_at,e.issue_key,e.execution_id FROM event_outbox o
        JOIN events e USING(event_id) WHERE e.repo_id=? AND o.event_id=? AND o.destination=?`).get(repoId, options.eventId, options.destination);
      if (!row || row.status !== 'failed') throw new Error('Only a failed telemetry delivery can be retried.');
      if (options.destination === 'hindsight' && !row.approved_at) throw new Error('Hindsight retry requires prior explicit approval.');
      const now = new Date().toISOString();
      db.prepare(`UPDATE event_outbox SET status='pending',attempts=0,next_attempt_at=?,last_error=NULL WHERE event_id=? AND destination=?`)
        .run(now, options.eventId, options.destination);
      event(db, repoId, String(row.issue_key), row.execution_id === null ? null : String(row.execution_id), 'telemetry_retry_queued', {
        eventId: options.eventId, destination: options.destination, queuedBy: localOwner(),
      });
      return { eventId: options.eventId, destination: options.destination, queued: true as const };
    });
    return tx();
  } finally { db.close(); }
}

async function hindsightRequest(base: string, bank: string, token: string | undefined, method: string,
  params: Record<string, unknown>, sessionId?: string, id: number | null = 1, fetcher: typeof fetch = fetch): Promise<{ body: Record<string, unknown>; sessionId?: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const response = await fetcher(`${base.replace(/\/$/, '')}/mcp/${encodeURIComponent(bank)}/`, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(id === null ? {} : { id }) }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`http-${response.status}`);
  const text = await response.text();
  let body: Record<string, unknown> = {};
  if (text.trim()) {
    try { body = JSON.parse(text) as Record<string, unknown>; }
    catch {
      const data = text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
      body = JSON.parse(data) as Record<string, unknown>;
    }
  }
  return { body, sessionId: response.headers.get('Mcp-Session-Id') ?? sessionId };
}

async function retainHindsightLesson(base: string, bank: string, token: string | undefined, args: {
  repoId: string; issue: string; category: string; targetBranch: string; targetCommit: string; branchCommit: string;
}, fetcher: typeof fetch = fetch): Promise<void> {
  const initial = await hindsightRequest(base, bank, token, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cezar-factory', version: '1' },
  }, undefined, 1, fetcher);
  const sessionId = initial.sessionId;
  if (initial.body.error || !sessionId) throw new Error('mcp-initialize-failed');
  await hindsightRequest(base, bank, token, 'notifications/initialized', {}, sessionId, null, fetcher);
  const category = /^[a-z-]{1,40}$/.test(args.category) ? args.category : 'uncategorized';
  const targetBranch = /^[A-Za-z0-9._/-]{1,100}$/.test(args.targetBranch) ? args.targetBranch : 'development';
  const shortSha = (value: string) => /^[0-9a-f]{7,40}$/i.test(value) ? value.slice(0, 12) : 'unknown';
  const lesson = `A preflight merge conflict in the ${category} category was resolved. Update the issue branch against ${targetBranch}, handle the conflict in its isolated workspace, and rerun lifecycle preflight before handoff.`;
  const evidence = `Issue #${args.issue}; target ${shortSha(args.targetCommit)}; branch ${shortSha(args.branchCommit)}; subsequent preflight was clean.`;
  const result = await hindsightRequest(base, bank, token, 'tools/call', { name: 'retain', arguments: {
    content: lesson, context: 'successful-fix', tags: [`project:${args.repoId}`, 'factory:workspace-lifecycle'],
    metadata: { project: args.repoId, workflow: 'workspace-lifecycle', issue: args.issue, evidence },
  } }, sessionId, 2, fetcher);
  const toolResult = result.body.result as { isError?: boolean; content?: unknown[] } | undefined;
  if (result.body.error || !toolResult || toolResult.isError || !Array.isArray(toolResult.content)) throw new Error('mcp-retain-failed');
}

/** Send bounded lifecycle spans to optional Langfuse; failures are recorded for later retry. */
export async function drainLifecycleOutbox(options: { cwd?: string; home?: string; limit?: number; fetcher?: typeof fetch } = {}): Promise<{
  delivered: number; deferred: number;
}> {
  const current = await gitTop(options.cwd ?? process.cwd());
  const { db, repoId } = openRegistry(current.commonDir, options.home);
  const fetcher = options.fetcher ?? fetch;
  let delivered = 0;
  let deferred = 0;
  const claimDelivery = (eventId: string, destination: 'langfuse' | 'hindsight'): string | null => {
    const token = randomUUID();
    const now = new Date().toISOString();
    const lease = new Date(Date.now() + 2 * 60_000).toISOString();
    const claimed = db.prepare(`INSERT INTO outbox_delivery_claims(event_id,destination,claim_token,lease_expires_at)
      VALUES(?,?,?,?) ON CONFLICT(event_id,destination) DO UPDATE SET claim_token=excluded.claim_token,lease_expires_at=excluded.lease_expires_at
      WHERE outbox_delivery_claims.lease_expires_at<=?`).run(eventId, destination, token, lease, now);
    return claimed.changes ? token : null;
  };
  const releaseDelivery = (eventId: string, destination: 'langfuse' | 'hindsight', token: string) => {
    db.prepare('DELETE FROM outbox_delivery_claims WHERE event_id=? AND destination=? AND claim_token=?').run(eventId, destination, token);
  };
  try {
    const rows = db.prepare(`SELECT o.event_id,o.attempts,e.issue_key,e.execution_id,e.event_type,e.timestamp
      FROM event_outbox o JOIN events e USING(event_id)
      WHERE e.repo_id=? AND o.destination='langfuse' AND o.status IN ('pending','failed') AND o.attempts<12 AND o.next_attempt_at<=?
      ORDER BY e.seq LIMIT ?`).all(repoId, new Date().toISOString(), Math.max(1, Math.min(100, options.limit ?? 20)));
    for (const row of rows) {
      const id = String(row.event_id);
      const claimToken = claimDelivery(id, 'langfuse');
      if (!claimToken) continue;
      const endpoint = process.env.LANGFUSE_HOST?.replace(/\/$/, '');
      const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
      const secretKey = process.env.LANGFUSE_SECRET_KEY;
      try {
        if (!endpoint || !publicKey || !secretKey) throw new Error('sink-unconfigured');
        const startNs = (BigInt(Date.parse(String(row.timestamp))) * 1_000_000n).toString();
        const traceId = createHash('sha256').update(`cezar:${id}`).digest('hex').slice(0, 32);
        const spanId = createHash('sha256').update(`cezar-span:${id}`).digest('hex').slice(0, 16);
        const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });
        const body = { resourceSpans: [{ resource: { attributes: [attribute('service.name', 'cezar-factory')] }, scopeSpans: [{ scope: { name: 'cezar.workspace.lifecycle' }, spans: [{
          traceId, spanId, name: String(row.event_type), startTimeUnixNano: startNs,
          endTimeUnixNano: (BigInt(startNs) + 1_000_000n).toString(), kind: 1,
          attributes: [attribute('workspace.issue', String(row.issue_key)), ...(row.execution_id ? [attribute('workspace.execution_id', String(row.execution_id))] : []), attribute('workspace.event_id', id)],
        }] }] }] };
        const response = await fetcher(`${endpoint}/api/public/otel/v1/traces`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-langfuse-ingestion-version': '4',
            Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}` },
          body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error(`http-${response.status}`);
        db.prepare(`UPDATE event_outbox SET status='delivered',attempts=attempts+1,delivered_at=?,last_error=NULL WHERE event_id=? AND destination='langfuse'`)
          .run(new Date().toISOString(), id);
        delivered++;
      } catch (error) {
        const message = error instanceof Error && /^http-\d+$/.test(error.message) ? error.message : (error instanceof Error && error.message === 'sink-unconfigured' ? error.message : 'delivery-unavailable');
        db.prepare(`UPDATE event_outbox SET status='failed',attempts=attempts+1,last_error=?,next_attempt_at=? WHERE event_id=? AND destination='langfuse'`)
          .run(message, new Date(Date.now() + Math.min(86_400_000, 60_000 * (2 ** Math.min(10, Number(row.attempts) || 0)))).toISOString(), id);
        deferred++;
      } finally {
        releaseDelivery(id, 'langfuse', claimToken);
      }
    }
    const hindsightRows = db.prepare(`SELECT o.event_id,o.attempts,e.issue_key,e.event_type,e.payload_json
      FROM event_outbox o JOIN events e USING(event_id)
      WHERE e.repo_id=? AND o.destination='hindsight' AND o.approved_at IS NOT NULL
        AND o.status IN ('pending','failed') AND o.attempts<12 AND o.next_attempt_at<=?
      ORDER BY e.seq LIMIT ?`).all(repoId, new Date().toISOString(), Math.max(1, Math.min(100, options.limit ?? 20)));
    for (const row of hindsightRows) {
      const id = String(row.event_id);
      const claimToken = claimDelivery(id, 'hindsight');
      if (!claimToken) continue;
      try {
        const base = process.env.HINDSIGHT_URL;
        const bank = process.env.HINDSIGHT_PROJECT_BANK;
        if (!base || !bank) throw new Error('sink-unconfigured');
        const payload = JSON.parse(String(row.payload_json)) as { category?: string; targetBranch?: string; targetCommit?: string; branchCommit?: string };
        await retainHindsightLesson(base, bank, process.env.HINDSIGHT_AUTH_TOKEN, {
          repoId, issue: String(row.issue_key), category: payload.category ?? 'uncategorized',
          targetBranch: payload.targetBranch ?? 'development', targetCommit: payload.targetCommit ?? '', branchCommit: payload.branchCommit ?? '',
        }, fetcher);
        db.prepare(`UPDATE event_outbox SET status='delivered',attempts=attempts+1,delivered_at=?,last_error=NULL
          WHERE event_id=? AND destination='hindsight'`).run(new Date().toISOString(), id);
        delivered++;
      } catch (error) {
        const message = error instanceof Error && /^http-\d+$/.test(error.message) ? error.message : (error instanceof Error && error.message === 'sink-unconfigured' ? error.message : 'delivery-unavailable');
        db.prepare(`UPDATE event_outbox SET status='failed',attempts=attempts+1,last_error=?,next_attempt_at=?
          WHERE event_id=? AND destination='hindsight'`).run(message,
          new Date(Date.now() + Math.min(86_400_000, 60_000 * (2 ** Math.min(10, Number(row.attempts) || 0)))).toISOString(), id);
        deferred++;
      } finally {
        releaseDelivery(id, 'hindsight', claimToken);
      }
    }
    return { delivered, deferred };
  } finally { db.close(); }
}

function rowRecord(row: Record<string, unknown>): LifecycleRecord {
  return {
    repoId: String(row.repo_id), issue: String(row.issue_key), state: String(row.state) as LifecycleState,
    executionId: String(row.execution_id), ownerId: String(row.owner_id), fencingToken: Number(row.fencing_token),
    leaseExpiresAt: String(row.lease_expires_at), workspacePath: String(row.path), branch: String(row.branch),
    baseCommit: String(row.base_commit), origin: String(row.origin) as WorkspaceOrigin,
    updatedAt: String(row.updated_at),
  };
}

function getActive(db: Database, repoId: string, issue: string): LifecycleRecord | null {
  const row = db.prepare(`SELECT w.repo_id,w.issue_key,e.state,e.id execution_id,e.owner_id,e.fencing_token,
    e.lease_expires_at,e.updated_at,s.path,s.branch,s.base_commit,s.origin
    FROM work_items w JOIN executions e ON e.id=w.active_execution_id
    JOIN workspaces s ON s.execution_id=e.id WHERE w.repo_id=? AND w.issue_key=? AND e.active=1`).get(repoId, issue);
  return row ? rowRecord(row) : null;
}

function saveClaim(db: Database, repoId: string, issue: string, owner: string, workspace: string,
  branch: string, base: string, origin: WorkspaceOrigin, minutes: number, requestedId?: string,
  allowReadyTransfer = false, allowTerminalTransfer = false): LifecycleRecord {
  const now = new Date();
  const nowIso = now.toISOString();
  const run = db.transaction(() => {
    const canonicalPath = (value: string) => {
      const absolute = resolve(value);
      return process.platform === 'win32' ? absolute.toLocaleLowerCase('en-US') : absolute;
    };
    const workspaceOwner = db.prepare(`SELECT e.issue_key,s.path FROM executions e
      JOIN workspaces s ON s.execution_id=e.id
      WHERE e.repo_id=? AND e.active=1`).all(repoId)
      .find((row) => canonicalPath(String(row.path)) === canonicalPath(workspace));
    if (workspaceOwner && String(workspaceOwner.issue_key) !== issue) {
      throw new Error(`Workspace ${workspace} is already owned by active issue ${String(workspaceOwner.issue_key)}.`);
    }
    db.prepare(`INSERT INTO work_items(repo_id,issue_key,state,created_at,updated_at)
      VALUES(?,?, 'claimed', ?, ?) ON CONFLICT(repo_id,issue_key) DO NOTHING`).run(repoId, issue, nowIso, nowIso);
    const item = db.prepare('SELECT * FROM work_items WHERE repo_id=? AND issue_key=?').get(repoId, issue) as Record<string, unknown>;
    const activeId = item.active_execution_id;
    let transferredFrom: LifecycleRecord | null = null;
    if (activeId) {
      const current = getActive(db, repoId, issue);
      if (current?.ownerId === owner && current.workspacePath === workspace) {
        if (Date.parse(current.leaseExpiresAt) <= now.getTime()) throw new Error(`Issue ${issue} owner lease expired; verify process liveness and use recover before resuming.`);
        return current;
      }
      const readyTransfer = allowReadyTransfer && current?.state === 'ready';
      const terminalTransfer = allowTerminalTransfer && current && ['working', 'validating', 'blocked', 'recoverable'].includes(current.state);
      if (!current || (!readyTransfer && !terminalTransfer)) {
        throw new Error(`Issue ${issue} already has active execution ${String(activeId)} owned by ${current?.ownerId ?? 'unknown'}.`);
      }
      const released = db.prepare(`UPDATE executions SET active=0,state='recoverable',updated_at=? WHERE id=? AND state=? AND active=1`)
        .run(nowIso, current.executionId, current.state);
      if (!released.changes) throw new Error(`Issue ${issue} lifecycle owner changed during transfer.`);
      transferredFrom = current;
      db.prepare('UPDATE work_items SET active_execution_id=NULL WHERE repo_id=? AND issue_key=?').run(repoId, issue);
    }
    const fence = Number(item.next_fence);
    const id = requestedId ?? randomUUID();
    const expiry = new Date(now.getTime() + minutes * 60_000).toISOString();
    db.prepare(`INSERT INTO executions(id,repo_id,issue_key,owner_id,fencing_token,state,lease_expires_at,heartbeat_at,active,created_at,updated_at)
      VALUES(?,?,?,?,?,'working',?,?,1,?,?)`).run(id, repoId, issue, owner, fence, expiry, nowIso, nowIso, nowIso);
    db.prepare(`INSERT INTO workspaces(execution_id,repo_id,path,branch,base_commit,origin,cleanup_policy,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, repoId, workspace, branch, base, origin, origin === 'adopted' ? 'never' : 'after-integration', nowIso);
    db.prepare(`UPDATE work_items SET active_execution_id=?,state='working',next_fence=?,updated_at=? WHERE repo_id=? AND issue_key=?`)
      .run(id, fence + 1, nowIso, repoId, issue);
    event(db, repoId, issue, id, 'claimed', { owner, fence, origin, workspace });
    if (transferredFrom) event(db, repoId, issue, transferredFrom.executionId,
      transferredFrom.state === 'ready' ? 'factory_phase_transferred' : 'factory_terminal_run_recovered', {
      fromExecutionId: transferredFrom.executionId, toExecutionId: id, fromOwner: transferredFrom.ownerId,
      fromState: transferredFrom.state, toOwner: owner, fence, workspace,
    });
    return getActive(db, repoId, issue)!;
  });
  return run();
}

async function listWorktrees(root: string): Promise<Array<{ path: string; branch?: string }>> {
  const lines = (await git(root, ['worktree', 'list', '--porcelain'])).split(/\r?\n/);
  const found: Array<{ path: string; branch?: string }> = [];
  let current: { path: string; branch?: string } | undefined;
  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      if (current) found.push(current);
      current = { path: line.slice(9) };
    } else if (line.startsWith('branch ') && current) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (!line && current) { found.push(current); current = undefined; }
  }
  if (current) found.push(current);
  return found;
}

function resolveIssue(value: string): string {
  const issue = value.trim().replace(/^#/, '');
  if (!/^\d+$/.test(issue) || !Number.isSafeInteger(Number(issue)) || Number(issue) < 1) throw new Error('Issue must be a positive numeric ID.');
  return issue;
}

function leaseMinutes(value: number | undefined): number {
  const minutes = value ?? 30;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error('Lease duration must be an integer from 1 to 1440 minutes.');
  return minutes;
}

export async function claimWorkspace(options: {
  issue: string; cwd?: string; owner?: string; base?: string; minutes?: number; home?: string;
}): Promise<LifecycleRecord> {
  const issue = resolveIssue(options.issue);
  const minutes = leaseMinutes(options.minutes);
  const current = await gitTop(options.cwd ?? process.cwd());
  const treesFromCurrent = await listWorktrees(current.root);
  const root = treesFromCurrent[0]?.path ?? current.root;
  const commonDir = current.commonDir;
  const owner = options.owner ?? localOwner();
  const existingRegistry = openRegistry(commonDir, options.home);
  try {
    const active = getActive(existingRegistry.db, existingRegistry.repoId, issue);
    if (active) {
      if (active.ownerId === owner && resolve(active.workspacePath) === resolve(current.root) && Date.parse(active.leaseExpiresAt) > Date.now()) return active;
      throw new Error(`Issue ${issue} already has active execution ${active.executionId} owned by ${active.ownerId} at ${active.workspacePath}. Resume in that workspace or recover the expired owner explicitly.`);
    }
  } finally { existingRegistry.db.close(); }
  const branch = `factory/issue-${issue}`;
  const target = options.base ?? 'dev';
  const targetRef = await git(root, ['rev-parse', '--verify', '--quiet', `${target}^{commit}`]).catch(() => '');
  const fork = targetRef || await git(root, ['rev-parse', '--verify', '--quiet', `origin/${target}^{commit}`]).catch(() => '');
  if (!fork) throw new Error(`Base ${target} (or origin/${target}) is not available locally. Fetch it, then retry.`);
  const path = resolve(root, '.ai', 'cezar', 'workspaces', `issue-${issue}`);
  const active = await listWorktrees(root);
  const existing = active.find((tree) => resolve(tree.path) === path);
  if (existing) {
    throw new Error(`Workspace path is already a registered Git worktree without an active lifecycle claim: ${path}. Adopt it explicitly or recover its registry entry.`);
  } else {
    const present = await stat(path).then(() => true, () => false);
    if (present) throw new Error(`Workspace path already exists but is not a registered Git worktree: ${path}`);
    const branchExists = await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
    if (branchExists) await git(root, ['worktree', 'add', path, branch]);
    else await git(root, ['worktree', 'add', '-b', branch, path, fork]);
  }
  const worktree = await gitTop(path);
  const { db, repoId } = openRegistry(commonDir, options.home);
  try {
    return saveClaim(db, repoId, issue, owner, worktree.root, worktree.branch, fork, 'factory-created', minutes);
  } finally { db.close(); }
}

export async function adoptWorkspace(options: {
  issue: string; cwd?: string; owner?: string; minutes?: number; home?: string;
}): Promise<LifecycleRecord> {
  const issue = resolveIssue(options.issue);
  const minutes = leaseMinutes(options.minutes);
  const worktree = await gitTop(options.cwd ?? process.cwd());
  const worktrees = await listWorktrees(worktree.root);
  if (!worktrees.some((tree) => resolve(tree.path) === worktree.root)) throw new Error('Current folder is not a registered Git worktree.');
  const topBranch = worktrees.find((tree) => resolve(tree.path) === worktree.root)?.branch;
  if ((topBranch ?? 'HEAD') !== worktree.branch) throw new Error('Git branch changed while the worktree was being inspected.');
  const { db, repoId } = openRegistry(worktree.commonDir, options.home);
  try {
    return saveClaim(db, repoId, issue, options.owner ?? localOwner(), worktree.root,
      worktree.branch, worktree.head, 'adopted', minutes);
  } finally { db.close(); }
}

/** Register an isolated Cezar automation run in the shared registry. This is
 * called by the scheduler after its own worktree has been created. */
export async function registerFactoryWorkspace(options: {
  issue: number; runId: string; repoRoot: string; workspacePath: string; baseCommit: string; home?: string;
  allowReadyTransfer?: boolean; allowTerminalTransfer?: boolean;
}): Promise<LifecycleRecord> {
  const issue = resolveIssue(String(options.issue));
  const workspace = await gitTop(options.workspacePath);
  const repo = await gitTop(options.repoRoot);
  const trees = await listWorktrees(repo.root);
  if (!trees.some((tree) => resolve(tree.path) === workspace.root)) throw new Error('Factory run path is not registered with Git.');
  if (workspace.commonDir !== repo.commonDir) throw new Error('Factory run worktree belongs to a different repository.');
  const baseCommit = await git(workspace.root, ['rev-parse', '--verify', `${options.baseCommit}^{commit}`]);
  const registry = openRegistry(repo.commonDir, options.home);
  try {
    return saveClaim(registry.db, registry.repoId, issue, `factory:${hostname()}:${options.runId}`,
      workspace.root, workspace.branch, baseCommit, 'factory-created', 30, options.runId,
      options.allowReadyTransfer, options.allowTerminalTransfer);
  } finally { registry.db.close(); }
}

export async function lifecycleStatus(options: { cwd?: string; issue?: string; home?: string } = {}): Promise<LifecycleRecord[]> {
  const { commonDir } = await gitTop(options.cwd ?? process.cwd());
  const { db, repoId } = openRegistry(commonDir, options.home);
  try {
    const query = `SELECT w.repo_id,w.issue_key,e.state,e.id execution_id,e.owner_id,e.fencing_token,
      e.lease_expires_at,e.updated_at,s.path,s.branch,s.base_commit,s.origin
      FROM work_items w JOIN executions e ON e.id=w.active_execution_id
      JOIN workspaces s ON s.execution_id=e.id WHERE w.repo_id=?`;
    const rows = options.issue
      ? [db.prepare(`${query} AND w.issue_key=?`).get(repoId, resolveIssue(options.issue))].filter(Boolean) as Record<string, unknown>[]
      : db.prepare(`${query} ORDER BY w.updated_at DESC`).all(repoId);
    return rows.map(rowRecord);
  } finally { db.close(); }
}

export async function lifecycleEvents(options: { cwd?: string; issue: string; limit?: number; home?: string }): Promise<Array<{
  eventId: string; type: string; timestamp: string; executionId: string | null; payload: unknown;
}>> {
  const issue = resolveIssue(options.issue);
  const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)));
  const { commonDir } = await gitTop(options.cwd ?? process.cwd());
  const { db, repoId } = openRegistry(commonDir, options.home);
  try {
    return db.prepare(`SELECT event_id,event_type,timestamp,execution_id,payload_json FROM events
      WHERE repo_id=? AND issue_key=? ORDER BY seq DESC LIMIT ?`).all(repoId, issue, limit).map((row) => ({
        eventId: String(row.event_id),
        type: String(row.event_type),
        timestamp: String(row.timestamp),
        executionId: row.execution_id === null ? null : String(row.execution_id),
        payload: JSON.parse(String(row.payload_json)),
      }));
  } finally { db.close(); }
}

/** Persist a failed post-merge validation attempt under the current execution fence. */
export async function recordIntegrationValidationFailure(options: {
  issue: string; executionId: string; fencingToken: number; detail: string; cwd?: string; home?: string;
}): Promise<number> {
  const issue = resolveIssue(options.issue);
  const { commonDir } = await gitTop(options.cwd ?? process.cwd());
  const { db, repoId } = openRegistry(commonDir, options.home);
  try {
    const tx = db.transaction(() => {
      const current = getActive(db, repoId, issue);
      if (!current || current.executionId !== options.executionId || current.fencingToken !== options.fencingToken || current.state !== 'integrating') {
        throw new Error('Validation failure record fenced by a newer lifecycle execution.');
      }
      const prior = db.prepare(`SELECT COUNT(*) AS count FROM events WHERE repo_id=? AND issue_key=? AND execution_id=? AND event_type='integration_validation_failed'`)
        .get(repoId, issue, options.executionId);
      const attempt = Number(prior?.count ?? 0) + 1;
      event(db, repoId, issue, options.executionId, 'integration_validation_failed', { attempt, detail: options.detail });
      return attempt;
    });
    return tx();
  } finally { db.close(); }
}

export async function lifecycleMetrics(options: { cwd?: string; home?: string; windowDays?: number; now?: number } = {}): Promise<{
  activeWorkspaces: number;
  expiredLeases: number;
  cleanupBacklog: number;
  preflightCount: number;
  conflictCount: number;
  conflictEscalations: number;
  conflictCategories: Record<string, number>;
  conflictRate: number | null;
  validationFailures: number;
  manualInterventions: number;
  completedIntegrations: number;
  averageTimeToIntegrationMs: number | null;
  autoRepairAttempts: number;
  autoRepairSuccesses: number;
  autoRepairSuccessRate: number | null;
  windowDays: number;
}> {
  const { commonDir } = await gitTop(options.cwd ?? process.cwd());
  const { db, repoId } = openRegistry(commonDir, options.home);
  const windowDays = Math.max(1, Math.min(365, Math.trunc(options.windowDays ?? 30)));
  const since = new Date((options.now ?? Date.now()) - windowDays * 86_400_000).toISOString();
  try {
    const count = (sql: string, ...params: unknown[]) => Number(db.prepare(sql).get(...params)?.count ?? 0);
    const activeWorkspaces = count('SELECT COUNT(*) count FROM executions WHERE repo_id=? AND active=1', repoId);
    const expiredLeases = count('SELECT COUNT(*) count FROM executions WHERE repo_id=? AND active=1 AND lease_expires_at<=?', repoId, new Date(options.now ?? Date.now()).toISOString());
    const cleanupBacklog = count(`SELECT COUNT(*) count FROM executions WHERE repo_id=? AND active=1
      AND state IN ('integrated','cleanup_pending')`, repoId);
    const eventRows = db.prepare(`SELECT execution_id,event_type,payload_json FROM events WHERE repo_id=? AND timestamp>=?`)
      .all(repoId, since);
    let preflightCount = 0;
    let conflictCount = 0;
    let conflictEscalations = 0;
    let autoRepairSuccesses = 0;
    const autoRepairExecutions = new Set<string>();
    const conflictCategories: Record<string, number> = {};
    let validationFailures = 0;
    let manualInterventions = 0;
    for (const row of eventRows) {
      const type = String(row.event_type);
      if (type === 'preflight_clean' || type === 'preflight_conflicts' || type === 'preflight_repaired') {
        preflightCount++;
        if (type === 'preflight_conflicts') conflictCount++;
      }
      if (type === 'preflight_conflicts') {
        const payload = JSON.parse(String(row.payload_json)) as { category?: string; repairAttempt?: number };
        const category = payload.category ?? 'uncategorized';
        conflictCategories[category] = (conflictCategories[category] ?? 0) + 1;
        if (payload.repairAttempt === 1 || payload.repairAttempt === undefined) autoRepairExecutions.add(String(row.execution_id));
      }
      if (type === 'conflict_repair_escalated') conflictEscalations++;
      if (type === 'preflight_repaired') autoRepairSuccesses++;
      if (type === 'state_changed') {
        const payload = JSON.parse(String(row.payload_json)) as { from?: string; to?: string };
        if (payload.from === 'validating' && payload.to === 'working') validationFailures++;
      }
      if (type === 'recovered' || type === 'manual_resume') manualInterventions++;
    }
    const integrations = db.prepare(`SELECT e.created_at,i.integrated_at FROM integrations i
      JOIN executions e ON e.id=i.execution_id WHERE i.repo_id=? AND i.integrated_at>=?`)
      .all(repoId, since);
    const elapsed = integrations.flatMap((row) => {
      const duration = Date.parse(String(row.integrated_at)) - Date.parse(String(row.created_at));
      return Number.isFinite(duration) && duration >= 0 ? [duration] : [];
    });
    return {
      activeWorkspaces,
      expiredLeases,
      cleanupBacklog,
      preflightCount,
      conflictCount,
      conflictEscalations,
      conflictCategories,
      conflictRate: preflightCount ? conflictCount / preflightCount : null,
      validationFailures,
      manualInterventions,
      completedIntegrations: integrations.length,
      averageTimeToIntegrationMs: elapsed.length ? Math.round(elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length) : null,
      autoRepairAttempts: autoRepairExecutions.size,
      autoRepairSuccesses,
      autoRepairSuccessRate: autoRepairExecutions.size ? autoRepairSuccesses / autoRepairExecutions.size : null,
      windowDays,
    };
  } finally { db.close(); }
}

/** Advisory only: report paths changed in more than one active issue workspace. */
export async function workspaceOverlaps(options: { cwd?: string; home?: string } = {}): Promise<Array<{
  issues: string[]; paths: string[]; workspaces: string[];
}>> {
  const records = await lifecycleStatus(options);
  const changedByIssue = new Map<string, { paths: Set<string>; workspace: string }>();
  for (const record of records) {
    if (!['working', 'validating', 'ready', 'integrating', 'blocked', 'recoverable'].includes(record.state)) continue;
    const collect = async (args: string[]) => (await git(record.workspacePath, args)).split('\0').filter(Boolean);
    const [committed, staged, unstaged, untracked] = await Promise.all([
      collect(['diff', '--name-only', '-z', `${record.baseCommit}...HEAD`]),
      collect(['diff', '--cached', '--name-only', '-z']),
      collect(['diff', '--name-only', '-z']),
      collect(['ls-files', '--others', '--exclude-standard', '-z']),
    ]);
    changedByIssue.set(record.issue, {
      paths: new Set([...committed, ...staged, ...unstaged, ...untracked].map((path) => path.replaceAll('\\', '/'))),
      workspace: record.workspacePath,
    });
  }
  const owners = new Map<string, Array<{ issue: string; workspace: string }>>();
  for (const [issue, item] of changedByIssue) for (const path of item.paths) {
    const rows = owners.get(path) ?? [];
    rows.push({ issue, workspace: item.workspace });
    owners.set(path, rows);
  }
  const byPair = new Map<string, { issues: string[]; paths: string[]; workspaces: string[] }>();
  for (const [path, rows] of owners) {
    if (rows.length < 2) continue;
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      const pair = [rows[i]!.issue, rows[j]!.issue].sort();
      const key = pair.join(':');
      const item = byPair.get(key) ?? { issues: pair, paths: [], workspaces: pair.map((issue) => changedByIssue.get(issue)!.workspace) };
      item.paths.push(path);
      byPair.set(key, item);
    }
  }
  return [...byPair.values()].map((item) => ({ ...item, paths: item.paths.sort() }));
}

/** Persist deterministic merge preflight evidence against the active fencing token. */
export async function recordWorkspacePreflight(options: {
  issue: string; executionId: string; fencingToken: number; targetBranch: string; targetRef: string;
  targetCommit: string; branchCommit: string; conflictingPaths: string[]; diagnostics?: string; cwd?: string; home?: string;
}): Promise<void> {
  const issue = resolveIssue(options.issue);
  const { commonDir } = await gitTop(options.cwd ?? process.cwd());
  const { db, repoId } = openRegistry(commonDir, options.home);
  try {
    const current = getActive(db, repoId, issue);
    if (!current || current.executionId !== options.executionId || current.fencingToken !== options.fencingToken) {
      throw new Error('Preflight evidence rejected: execution is stale or fenced.');
    }
    if (!['working', 'validating', 'ready', 'blocked', 'recoverable'].includes(current.state)) {
      throw new Error(`Preflight evidence rejected from lifecycle state ${current.state}.`);
    }
    const conflict = options.conflictingPaths.length > 0;
    const previous = Number(db.prepare(`SELECT COUNT(*) count FROM events WHERE repo_id=? AND issue_key=?
      AND execution_id=? AND event_type='preflight_conflicts'`).get(repoId, issue, current.executionId)?.count ?? 0);
    const priorConflict = previous ? db.prepare(`SELECT payload_json FROM events WHERE repo_id=? AND issue_key=?
      AND execution_id=? AND event_type='preflight_conflicts' ORDER BY seq DESC LIMIT 1`).get(repoId, issue, current.executionId) : undefined;
    const priorPayload = priorConflict ? JSON.parse(String(priorConflict.payload_json)) as { category?: string; conflictingPaths?: string[] } : undefined;
    const category = conflict ? (options.conflictingPaths.some((path) => /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum)$/i.test(path)) ? 'dependency-lock'
      : options.conflictingPaths.some((path) => /(^|\/)(workflows|skills|policies|scripts)\//i.test(path)) ? 'factory-config'
        : options.conflictingPaths.some((path) => /\.(png|jpe?g|webp|pdf|docx?|xlsx?)$/i.test(path)) ? 'binary-or-document' : 'source-or-other') : undefined;
    const tx = db.transaction(() => {
      event(db, repoId, issue, current.executionId,
        conflict ? 'preflight_conflicts' : (previous ? 'preflight_repaired' : 'preflight_clean'), {
        targetBranch: options.targetBranch,
        targetRef: options.targetRef,
        targetCommit: options.targetCommit,
        branchCommit: options.branchCommit,
        conflictingPaths: options.conflictingPaths,
        ...(conflict ? { category, repairAttempt: previous + 1 } : previous ? {
          category: priorPayload?.category ?? 'uncategorized',
          resolvedPaths: (priorPayload?.conflictingPaths ?? []).slice(0, 20),
        } : {}),
        diagnostics: options.diagnostics?.slice(0, 16_000),
      });
      if (conflict && previous >= 1 && current.state !== 'blocked') {
        const now = new Date().toISOString();
        if (ALLOWED[current.state].includes('blocked')) {
          db.prepare('UPDATE executions SET state=\'blocked\',updated_at=?,heartbeat_at=? WHERE id=? AND fencing_token=? AND active=1')
            .run(now, now, current.executionId, current.fencingToken);
          db.prepare('UPDATE work_items SET state=\'blocked\',updated_at=? WHERE repo_id=? AND issue_key=? AND active_execution_id=?')
            .run(now, repoId, issue, current.executionId);
        }
        event(db, repoId, issue, current.executionId, 'conflict_repair_escalated', { category, attempts: previous + 1, conflictingPaths: options.conflictingPaths });
      }
    });
    tx();
  } finally { db.close(); }
}

export async function transitionWorkspace(options: {
  issue: string; to: LifecycleState; cwd?: string; executionId?: string; fencingToken?: number; home?: string;
}): Promise<LifecycleRecord> {
  const issue = resolveIssue(options.issue);
  const { commonDir } = await gitTop(options.cwd ?? process.cwd());
  const { db, repoId } = openRegistry(commonDir, options.home);
  try {
    const tx = db.transaction(() => {
      const current = getActive(db, repoId, issue);
      if (!current) throw new Error(`Issue ${issue} has no active lifecycle execution.`);
      if (options.executionId && current.executionId !== options.executionId) throw new Error('Stale execution ID; lifecycle mutation fenced.');
      if (options.fencingToken !== undefined && current.fencingToken !== options.fencingToken) throw new Error('Stale fencing token; lifecycle mutation rejected.');
      if (!ALLOWED[current.state].includes(options.to)) throw new Error(`Illegal lifecycle transition: ${current.state} -> ${options.to}.`);
      const now = new Date().toISOString();
      const active = TERMINAL.has(options.to) ? 0 : 1;
      const changed = db.prepare(`UPDATE executions SET state=?,active=?,updated_at=?,heartbeat_at=?
        WHERE id=? AND fencing_token=? AND active=1 AND lease_expires_at>?`)
        .run(options.to, active, now, now, current.executionId, current.fencingToken, now);
      if (!changed.changes) throw new Error('Lifecycle mutation rejected: lease expired or execution was fenced.');
      db.prepare('UPDATE work_items SET state=?,active_execution_id=?,updated_at=? WHERE repo_id=? AND issue_key=?')
        .run(options.to, active ? current.executionId : null, now, repoId, issue);
      event(db, repoId, issue, current.executionId, 'state_changed', { from: current.state, to: options.to });
      if (!active) return { ...current, state: options.to, updatedAt: now };
      return getActive(db, repoId, issue)!;
    });
    return tx();
  } finally { db.close(); }
}

/** Explicitly resume a blocked execution under its current fence; record operator action. */
export async function resumeBlockedWorkspace(options: { issue: string; cwd?: string; home?: string }): Promise<LifecycleRecord> {
  const issue = resolveIssue(options.issue);
  const { commonDir } = await gitTop(options.cwd ?? process.cwd());
  const { db, repoId } = openRegistry(commonDir, options.home);
  try {
    const tx = db.transaction(() => {
      const current = getActive(db, repoId, issue);
      if (!current || current.state !== 'blocked') throw new Error(`Issue ${issue} is not blocked.`);
      const now = new Date().toISOString();
      const updated = db.prepare(`UPDATE executions SET state='working',updated_at=?,heartbeat_at=?
        WHERE id=? AND fencing_token=? AND active=1 AND lease_expires_at>?`)
        .run(now, now, current.executionId, current.fencingToken, now);
      if (!updated.changes) throw new Error('Resume refused: lease expired or execution was fenced; recover it first.');
      db.prepare(`UPDATE work_items SET state='working',updated_at=? WHERE repo_id=? AND issue_key=? AND active_execution_id=?`)
        .run(now, repoId, issue, current.executionId);
      event(db, repoId, issue, current.executionId, 'manual_resume', { from: 'blocked', to: 'working', fencingToken: current.fencingToken });
      return getActive(db, repoId, issue)!;
    });
    return tx();
  } finally { db.close(); }
}

export async function heartbeatWorkspace(options: {
  issue: string; executionId: string; fencingToken: number; cwd?: string; minutes?: number; home?: string;
}): Promise<LifecycleRecord> {
  const issue = resolveIssue(options.issue);
  const minutes = leaseMinutes(options.minutes);
  const { commonDir } = await gitTop(options.cwd ?? process.cwd());
  const { db, repoId } = openRegistry(commonDir, options.home);
  try {
    const now = new Date();
    const expires = new Date(now.getTime() + minutes * 60_000).toISOString();
    const result = db.prepare(`UPDATE executions SET lease_expires_at=?,heartbeat_at=?,updated_at=?
      WHERE id=? AND repo_id=? AND issue_key=? AND fencing_token=? AND active=1 AND lease_expires_at>?`)
      .run(expires, now.toISOString(), now.toISOString(), options.executionId, repoId, issue, options.fencingToken, now.toISOString());
    if (!result.changes) throw new Error('Heartbeat rejected: execution is stale, closed, or fenced by a newer owner.');
    event(db, repoId, issue, options.executionId, 'heartbeat', { leaseExpiresAt: expires });
    return getActive(db, repoId, issue)!;
  } finally { db.close(); }
}

/** Ready work has no live coding worker to renew its lease. The local manager
 * may retain the verified handoff while waiting for GitHub auto-merge. */
export async function renewReadyWorkspaceLease(options: {
  issue: string; executionId: string; fencingToken: number; cwd?: string; minutes?: number; home?: string;
}): Promise<LifecycleRecord> {
  const issue = resolveIssue(options.issue);
  const minutes = leaseMinutes(options.minutes);
  const { commonDir } = await gitTop(options.cwd ?? process.cwd());
  const { db, repoId } = openRegistry(commonDir, options.home);
  try {
    const tx = db.transaction(() => {
      const current = getActive(db, repoId, issue);
      if (!current || current.executionId !== options.executionId || current.fencingToken !== options.fencingToken || current.state !== 'ready') {
        throw new Error('Ready workspace lease renewal rejected: execution is stale, closed, or no longer ready.');
      }
      if (Date.parse(current.leaseExpiresAt) > Date.now() + 15 * 60_000) return current;
      const now = new Date();
      const expires = new Date(now.getTime() + minutes * 60_000).toISOString();
      const result = db.prepare(`UPDATE executions SET lease_expires_at=?,heartbeat_at=?,updated_at=?
        WHERE id=? AND repo_id=? AND issue_key=? AND fencing_token=? AND state='ready' AND active=1`)
        .run(expires, now.toISOString(), now.toISOString(), options.executionId, repoId, issue, options.fencingToken);
      if (!result.changes) throw new Error('Ready workspace lease renewal rejected: execution changed or was fenced.');
      event(db, repoId, issue, options.executionId, 'ready_lease_renewed', { leaseExpiresAt: expires });
      return getActive(db, repoId, issue)!;
    });
    return tx();
  } finally { db.close(); }
}

/** Resume cleanup after verified integration and durable remote bookkeeping,
 * even if the former coding lease expired while GitHub was unavailable. */
export async function finalizeIntegratedWorkspace(options: {
  issue: string; executionId: string; fencingToken: number; cwd?: string; home?: string;
}): Promise<LifecycleRecord> {
  const issue = resolveIssue(options.issue);
  const { commonDir } = await gitTop(options.cwd ?? process.cwd());
  const { db, repoId } = openRegistry(commonDir, options.home);
  try {
    const tx = db.transaction(() => {
      const current = getActive(db, repoId, issue);
      if (!current || current.executionId !== options.executionId || current.fencingToken !== options.fencingToken) {
        throw new Error('Finalization rejected: execution is stale or fenced.');
      }
      if (current.state !== 'integrated') throw new Error(`Finalization requires integrated state (current: ${current.state}).`);
      const now = new Date().toISOString();
      const changed = db.prepare(`UPDATE executions SET state='cleanup_pending',lease_expires_at=?,updated_at=?,heartbeat_at=?
        WHERE id=? AND fencing_token=? AND active=1 AND state='integrated'`)
        .run(new Date(Date.now() + 30 * 60_000).toISOString(), now, now, options.executionId, options.fencingToken);
      if (!changed.changes) throw new Error('Finalization rejected: execution changed or was fenced.');
      db.prepare(`UPDATE work_items SET state='cleanup_pending',updated_at=? WHERE repo_id=? AND issue_key=? AND active_execution_id=?`)
        .run(now, repoId, issue, options.executionId);
      event(db, repoId, issue, options.executionId, 'cleanup_queued', { reason: 'remote_issue_status_synchronized' });
      return getActive(db, repoId, issue)!;
    });
    return tx();
  } finally { db.close(); }
}

export async function handoffWorkspace(options: {
  executionId: string; fencingToken: number; cwd?: string; home?: string;
}): Promise<LifecycleRecord> {
  const { commonDir } = await gitTop(options.cwd ?? process.cwd());
  const { db, repoId } = openRegistry(commonDir, options.home);
  try {
    const issue = db.prepare('SELECT issue_key FROM executions WHERE id=? AND repo_id=?').get(options.executionId, repoId);
    if (!issue) throw new Error('Unknown lifecycle execution.');
    const active = getActive(db, repoId, String(issue.issue_key));
    if (!active || active.executionId !== options.executionId || active.fencingToken !== options.fencingToken) {
      throw new Error('Handoff rejected: execution is stale or fenced.');
    }
    const dirty = await git(active.workspacePath, ['status', '--porcelain', '--untracked-files=all']);
    if (dirty) throw new Error(`Handoff refused: workspace has uncommitted changes. Commit or preserve them before handoff.\n${dirty}`);
    return transitionWorkspace({ issue: String(issue.issue_key), to: 'ready', cwd: options.cwd, executionId: options.executionId, fencingToken: options.fencingToken, home: options.home });
  } finally { db.close(); }
}

export async function completeIntegration(options: {
  issue: string; executionId: string; fencingToken: number; targetBranch: string;
  pullRequest: string; headCommit: string; integratedCommit: string; integrationLockToken: string; cwd?: string; home?: string;
}): Promise<LifecycleRecord> {
  const issue = resolveIssue(options.issue);
  const { commonDir } = await gitTop(options.cwd ?? process.cwd());
  const { db, repoId } = openRegistry(commonDir, options.home);
  try {
    const tx = db.transaction(() => {
      const current = getActive(db, repoId, issue);
      if (!current || current.executionId !== options.executionId || current.fencingToken !== options.fencingToken) {
        throw new Error('Integration result rejected: execution is stale or fenced.');
      }
      if (current.state !== 'integrating') throw new Error(`Integration result cannot be recorded from ${current.state}.`);
      const now = new Date().toISOString();
      const lock = db.prepare(`SELECT 1 FROM integration_locks WHERE repo_id=? AND target_branch=?
        AND execution_id=? AND lock_token=? AND lease_expires_at>?`).get(repoId, options.targetBranch, current.executionId, options.integrationLockToken, now);
      if (!lock) throw new Error('Integration result rejected: target lock expired or was fenced.');
      db.prepare(`INSERT INTO integrations(repo_id,issue_key,execution_id,target_branch,pull_request,head_commit,integrated_commit,validation_result,integrated_at)
        VALUES(?,?,?,?,?,?,?,'passed',?)`).run(repoId, issue, current.executionId, options.targetBranch, options.pullRequest,
          options.headCommit, options.integratedCommit, now);
      const changed = db.prepare(`UPDATE executions SET state='integrated',updated_at=?,heartbeat_at=?
        WHERE id=? AND fencing_token=? AND active=1 AND lease_expires_at>?`)
        .run(now, now, current.executionId, current.fencingToken, now);
      if (!changed.changes) throw new Error('Integration result rejected: execution lease expired or was fenced.');
      db.prepare(`UPDATE work_items SET state='integrated',updated_at=? WHERE repo_id=? AND issue_key=?`)
        .run(now, repoId, issue);
      event(db, repoId, issue, current.executionId, 'integrated', {
        targetBranch: options.targetBranch, pullRequest: options.pullRequest,
        headCommit: options.headCommit, integratedCommit: options.integratedCommit,
        validationResult: 'passed',
      });
      return getActive(db, repoId, issue)!;
    });
    return tx();
  } finally { db.close(); }
}

export async function acquireIntegrationLock(options: {
  issue: string; executionId: string; fencingToken: number; targetBranch: string; cwd?: string; home?: string;
}): Promise<string> {
  const issue = resolveIssue(options.issue);
  const { commonDir } = await gitTop(options.cwd ?? process.cwd());
  const { db, repoId } = openRegistry(commonDir, options.home);
  try {
    const tx = db.transaction(() => {
      const current = getActive(db, repoId, issue);
      if (!current || current.executionId !== options.executionId || current.fencingToken !== options.fencingToken ||
          current.state !== 'ready' || Date.parse(current.leaseExpiresAt) <= Date.now()) {
        throw new Error('Integration lock refused: issue is not ready under this active fencing token.');
      }
      const existing = db.prepare('SELECT * FROM integration_locks WHERE repo_id=? AND target_branch=?').get(repoId, options.targetBranch);
      if (existing && Date.parse(String(existing.lease_expires_at)) > Date.now()) {
        throw new Error(`Integration target ${options.targetBranch} already has a local lock; inspect it with doctor before recovery.`);
      }
      const now = new Date();
      const token = randomUUID();
      db.prepare(`INSERT INTO integration_locks(repo_id,target_branch,execution_id,lock_token,lease_expires_at) VALUES(?,?,?,?,?)
        ON CONFLICT(repo_id,target_branch) DO UPDATE SET execution_id=excluded.execution_id,lock_token=excluded.lock_token,lease_expires_at=excluded.lease_expires_at`)
        .run(repoId, options.targetBranch, options.executionId, token, new Date(now.getTime() + 30 * 60_000).toISOString());
      event(db, repoId, issue, options.executionId, existing ? 'integration_lock_reclaimed' : 'integration_lock_acquired', { targetBranch: options.targetBranch, token });
      return token;
    });
    return tx();
  } finally { db.close(); }
}

export async function renewIntegrationLock(options: {
  issue: string; executionId: string; fencingToken: number; targetBranch: string; lockToken: string; cwd?: string; home?: string;
}): Promise<void> {
  const issue = resolveIssue(options.issue);
  const { commonDir } = await gitTop(options.cwd ?? process.cwd());
  const { db, repoId } = openRegistry(commonDir, options.home);
  try {
    const now = new Date();
    const active = getActive(db, repoId, issue);
    if (!active || active.executionId !== options.executionId || active.fencingToken !== options.fencingToken) throw new Error('Integration lock heartbeat fenced.');
    const result = db.prepare(`UPDATE integration_locks SET lease_expires_at=? WHERE repo_id=? AND target_branch=?
      AND execution_id=? AND lock_token=? AND lease_expires_at>?`)
      .run(new Date(now.getTime() + 30 * 60_000).toISOString(), repoId, options.targetBranch, options.executionId, options.lockToken, now.toISOString());
    if (!result.changes) throw new Error('Integration lock expired or was replaced.');
  } finally { db.close(); }
}

export async function releaseIntegrationLock(options: {
  issue: string; executionId: string; targetBranch: string; lockToken: string; cwd?: string; home?: string;
}): Promise<void> {
  const issue = resolveIssue(options.issue);
  const { commonDir } = await gitTop(options.cwd ?? process.cwd());
  const { db, repoId } = openRegistry(commonDir, options.home);
  try {
    const result = db.prepare('DELETE FROM integration_locks WHERE repo_id=? AND target_branch=? AND execution_id=? AND lock_token=?')
      .run(repoId, options.targetBranch, options.executionId, options.lockToken);
    if (!result.changes) throw new Error('Integration lock ownership changed; refusing to release another execution\'s lock.');
    event(db, repoId, issue, options.executionId, 'integration_lock_released', { targetBranch: options.targetBranch });
  } finally { db.close(); }
}

export async function recoverWorkspace(options: {
  issue: string; cwd?: string; owner?: string; force?: boolean; home?: string;
}): Promise<LifecycleRecord> {
  const issue = resolveIssue(options.issue);
  const { commonDir } = await gitTop(options.cwd ?? process.cwd());
  const { db, repoId } = openRegistry(commonDir, options.home);
  try {
    const tx = db.transaction(() => {
      const old = getActive(db, repoId, issue);
      if (!old) throw new Error(`Issue ${issue} has no active execution to recover.`);
      const match = /^external:([^:]+):(\d+)(?::.*)?$/.exec(old.ownerId);
      const ownerHost = match?.[1];
      const pid = match ? Number(match[2]) : undefined;
      let alive: boolean | undefined;
      if (ownerHost === hostname() && pid) {
        try { process.kill(pid, 0); alive = true; } catch (error) { alive = (error as NodeJS.ErrnoException).code === 'EPERM'; }
      }
      if (alive && !options.force) throw new Error(`Owner process ${pid} is still alive; recovery refused.`);
      if (alive === undefined && !options.force) throw new Error('Owner liveness is unverifiable; use the explicit --force operator override after checking the host.');
      if (Date.parse(old.leaseExpiresAt) > Date.now() && !options.force) throw new Error('Lease has not expired; recovery refused.');
      const now = new Date().toISOString();
      const item = db.prepare('SELECT next_fence FROM work_items WHERE repo_id=? AND issue_key=?').get(repoId, issue) as Record<string, unknown>;
      const fence = Number(item.next_fence);
      const id = randomUUID();
      const owner = options.owner ?? localOwner();
      const expires = new Date(Date.now() + 30 * 60_000).toISOString();
      db.prepare('UPDATE executions SET active=0,state=\'recoverable\',updated_at=? WHERE id=? AND fencing_token=?').run(now, old.executionId, old.fencingToken);
      db.prepare('DELETE FROM integration_locks WHERE repo_id=? AND execution_id=?').run(repoId, old.executionId);
      db.prepare(`INSERT INTO executions(id,repo_id,issue_key,owner_id,fencing_token,state,lease_expires_at,heartbeat_at,active,created_at,updated_at)
        VALUES(?,?,?,?,?,'working',?,?,1,?,?)`).run(id, repoId, issue, owner, fence, expires, now, now, now);
      db.prepare(`INSERT INTO workspaces(execution_id,repo_id,path,branch,base_commit,origin,cleanup_policy,created_at)
        SELECT ?,repo_id,path,branch,base_commit,origin,cleanup_policy,? FROM workspaces WHERE execution_id=?`).run(id, now, old.executionId);
      db.prepare('UPDATE work_items SET active_execution_id=?,state=\'working\',next_fence=?,updated_at=? WHERE repo_id=? AND issue_key=?')
        .run(id, fence + 1, now, repoId, issue);
      event(db, repoId, issue, id, 'recovered', { previousExecutionId: old.executionId, previousOwner: old.ownerId, fence, forced: !!options.force });
      return getActive(db, repoId, issue)!;
    });
    return tx();
  } finally { db.close(); }
}

export async function pruneWorkspace(options: { issue: string; cwd?: string; home?: string }): Promise<{ removed: boolean; reason: string }> {
  const issue = resolveIssue(options.issue);
  const current = await gitTop(options.cwd ?? process.cwd());
  const treesFromCurrent = await listWorktrees(current.root);
  const root = treesFromCurrent[0]?.path ?? current.root;
  const commonDir = current.commonDir;
  const { db, repoId } = openRegistry(commonDir, options.home);
  try {
    const row = db.prepare(`SELECT e.id,e.state,s.path,s.origin,s.cleanup_policy FROM work_items w
      JOIN executions e ON e.id=w.active_execution_id JOIN workspaces s ON s.execution_id=e.id
      WHERE w.repo_id=? AND w.issue_key=?`).get(repoId, issue);
    if (!row) throw new Error(`Issue ${issue} has no registered workspace.`);
    if (row.origin === 'adopted' || row.cleanup_policy !== 'after-integration') {
      if (row.state !== 'integrated' && row.state !== 'cleanup_pending') return { removed: false, reason: 'Adopted developer workspaces are retained.' };
      const now = new Date().toISOString();
      db.prepare('UPDATE executions SET state=\'closed\',active=0,updated_at=? WHERE id=?').run(now, String(row.id));
      db.prepare('UPDATE work_items SET state=\'closed\',active_execution_id=NULL,updated_at=? WHERE repo_id=? AND issue_key=?').run(now, repoId, issue);
      event(db, repoId, issue, String(row.id), 'workspace_retained_after_integration', { path: String(row.path), origin: String(row.origin) });
      return { removed: false, reason: 'Integrated developer workspace retained; lifecycle claim closed.' };
    }
    if (row.state !== 'integrated' && row.state !== 'cleanup_pending') throw new Error('Prune is allowed only after verified integration.');
    const target = resolve(String(row.path));
    const allowedRoots = [resolve(root, '.ai', 'cezar', 'workspaces'), resolve(root, '.ai', 'cezar', 'worktrees')];
    const contained = allowedRoots.some((allowedRoot) => {
      const rel = relative(allowedRoot, target);
      return rel !== '' && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel);
    });
    if (!contained) throw new Error(`Refusing cleanup outside a registered Factory workspace root: ${target}`);
    const trees = await listWorktrees(root);
    if (!trees.some((tree) => resolve(tree.path) === target)) {
      if (['integrated', 'cleanup_pending'].includes(String(row.state)) && !existsSync(target)) {
        const now = new Date().toISOString();
        db.prepare('UPDATE executions SET state=\'closed\',active=0,updated_at=? WHERE id=?').run(now, String(row.id));
        db.prepare('UPDATE work_items SET state=\'closed\',active_execution_id=NULL,updated_at=? WHERE repo_id=? AND issue_key=?').run(now, repoId, issue);
        event(db, repoId, issue, String(row.id), 'cleanup_reconciled', { path: target, alreadyRemoved: true });
        return { removed: true, reason: 'Integrated workspace was already removed before the registry finalized cleanup.' };
      }
      throw new Error('Workspace path is no longer registered with Git; preserving state for manual recovery.');
    }
    const dirty = await git(target, ['status', '--porcelain']);
    if (dirty) throw new Error('Workspace has uncommitted changes; cleanup refused.');
    await git(root, ['worktree', 'remove', target]);
    await git(root, ['worktree', 'prune']);
    const now = new Date().toISOString();
    db.prepare('UPDATE executions SET state=\'closed\',active=0,updated_at=? WHERE id=?').run(now, String(row.id));
    db.prepare('UPDATE work_items SET state=\'closed\',active_execution_id=NULL,updated_at=? WHERE repo_id=? AND issue_key=?').run(now, repoId, issue);
    event(db, repoId, issue, String(row.id), 'workspace_pruned', { path: target });
    return { removed: true, reason: 'Factory-created workspace was clean and removed after verified integration.' };
  } finally { db.close(); }
}

/** Reconcile crash-interrupted finalization at process startup; only cleanup_pending Factory trees can be removed. */
export async function reconcileWorkspaceLifecycle(options: { cwd?: string; home?: string } = {}): Promise<{
  repoRoot: string; findings: string[]; cleaned: string[];
}> {
  const report = await lifecycleDoctor(options);
  const cleaned: string[] = [];
  const findings = [...report.findings];
  for (const record of report.registered) {
    // `integrated` is a durable pending row until the caller confirms remote
    // issue bookkeeping. Only cleanup_pending is safe for startup pruning.
    if (record.state !== 'cleanup_pending' || !['factory-created', 'adopted'].includes(record.origin)) continue;
    try {
      const result = await pruneWorkspace({ issue: record.issue, cwd: report.repoRoot, home: options.home });
      if (result.removed) {
        cleaned.push(record.issue);
      }
      // Adopted cleanup_pending rows are closed by pruneWorkspace without
      // removing developer files. Clear diagnostics that closure resolved.
      if (record.origin === 'adopted' || result.removed) for (let i = findings.length - 1; i >= 0; i--) {
        if (findings[i]!.startsWith(`Issue ${record.issue}: registry workspace is missing`) ||
          findings[i]!.startsWith(`Issue ${record.issue}: adopted workspace`)) findings.splice(i, 1);
      }
    } catch (error) {
      findings.push(`Issue ${record.issue}: startup cleanup deferred: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { repoRoot: report.repoRoot, findings, cleaned };
}

export async function lifecycleDoctor(options: { cwd?: string; home?: string } = {}): Promise<{ repoRoot: string; registered: LifecycleRecord[]; findings: string[] }> {
  const current = await gitTop(options.cwd ?? process.cwd());
  const treesFromCurrent = await listWorktrees(current.root);
  const root = treesFromCurrent[0]?.path ?? current.root;
  const commonDir = current.commonDir;
  const { db, repoId } = openRegistry(commonDir, options.home);
  try {
    const registered = await lifecycleStatus({ cwd: root, home: options.home });
    const trees = await listWorktrees(root);
    const findings: string[] = [];
    for (const record of registered) {
      if (!trees.some((tree) => resolve(tree.path) === resolve(record.workspacePath))) findings.push(`Issue ${record.issue}: registry workspace is missing (${record.workspacePath}).`);
      const expired = Date.parse(record.leaseExpiresAt) <= Date.now();
      if (record.state === 'integrated') findings.push(`Issue ${record.issue}: verified integration is waiting for GitHub issue status synchronization.`);
      else if (expired) findings.push(`Issue ${record.issue}: lease expired; verify owner liveness before recovery.`);
      if (record.origin === 'adopted' && record.state === 'cleanup_pending') findings.push(`Issue ${record.issue}: adopted workspace must never be pruned automatically.`);
    }
    const locks = db.prepare('SELECT target_branch,execution_id,lease_expires_at FROM integration_locks WHERE repo_id=?').all(repoId);
    for (const lock of locks) {
      if (Date.parse(String(lock.lease_expires_at)) <= Date.now()) findings.push(`Integration lock for ${String(lock.target_branch)} expired under execution ${String(lock.execution_id)}; recovery is required.`);
      else findings.push(`Integration target ${String(lock.target_branch)} is locked by execution ${String(lock.execution_id)}.`);
    }
    const orphaned = trees.filter((tree) => tree.path.includes(`${join('.ai', 'cezar', 'workspaces')}`));
    for (const tree of orphaned) if (!registered.some((record) => resolve(record.workspacePath) === resolve(tree.path))) findings.push(`Unregistered worktree: ${tree.path}.`);
    return { repoRoot: root, registered, findings };
  } finally { db.close(); }
}

export function verifiedFactoryContext(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Promise<{
  managed: boolean; reason: string; execution?: LifecycleRecord;
}> {
  return (async () => {
    if (env.FACTORY_MANAGED !== '1') return { managed: false, reason: 'Factory-managed marker is absent.' };
    const runId = env.FACTORY_RUN_ID;
    const issue = env.FACTORY_ISSUE;
    const owner = env.FACTORY_OWNER_ID;
    const token = Number(env.FACTORY_FENCING_TOKEN);
    if (!runId || !issue || !owner || !Number.isSafeInteger(token) || token < 1) return { managed: false, reason: 'Factory context is incomplete.' };
    const matches = await lifecycleStatus({ cwd, issue }).catch(() => []);
    const execution = matches[0];
    if (!execution || execution.executionId !== runId || execution.ownerId !== owner || execution.fencingToken !== token ||
      (env.FACTORY_WORKSPACE && resolve(env.FACTORY_WORKSPACE) !== resolve(execution.workspacePath)) ||
      execution.leaseExpiresAt <= new Date().toISOString()) {
      return { managed: false, reason: 'Factory context does not match an active local claim.' };
    }
    return { managed: true, reason: 'Factory execution and fencing token verified.', execution };
  })();
}

/** Synchronous lookup used immediately before an agent process is spawned. */
export function factoryContextForRun(repoRoot: string, issue: number, runId: string): LifecycleRecord | null {
  try {
    const commonRaw = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true }).trim();
    const commonDir = realpathSync(isAbsolute(commonRaw) ? commonRaw : resolve(repoRoot, commonRaw));
    const registry = openRegistry(commonDir);
    try {
      const row = getActive(registry.db, registry.repoId, String(issue));
      return row?.executionId === runId && row.ownerId === `factory:${hostname()}:${runId}` &&
        Date.parse(row.leaseExpiresAt) > Date.now() ? row : null;
    } finally { registry.db.close(); }
  } catch { return null; }
}
