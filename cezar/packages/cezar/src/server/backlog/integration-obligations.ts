import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

interface SqlStatement { run(...p: unknown[]): { changes: number }; get(...p: unknown[]): Record<string, unknown> | undefined; all(...p: unknown[]): Record<string, unknown>[] }
interface SqlDatabase { exec(sql: string): void; prepare(sql: string): SqlStatement; pragma(s: string): unknown; transaction<T extends (...a: never[]) => unknown>(fn: T): T; close(): void }
const require = createRequire(import.meta.url);

/**
 * Durable integration obligations (#199). An obligation records that two concurrently running
 * issues overlap and must be reconciled. It is keyed idempotently (`integration:<a>+<b>`, see
 * scheduling.ts `obligationKey`), so replays, retries and duplicate schedulers never create
 * duplicates. A GitHub issue is materialized ONLY when the overlap is committed or a human/agent
 * reconciliation is actually required, never for every predicted overlap.
 */
export const OBLIGATION_STATES = ['open', 'merge-pending', 'verifying', 'needs-agent', 'resolved', 'cancelled'] as const;
export type ObligationState = (typeof OBLIGATION_STATES)[number];

const TRANSITIONS: Record<ObligationState, readonly ObligationState[]> = {
  open: ['merge-pending', 'needs-agent', 'resolved', 'cancelled'],
  'merge-pending': ['verifying', 'needs-agent', 'open', 'cancelled'],
  verifying: ['resolved', 'needs-agent', 'merge-pending'],
  'needs-agent': ['merge-pending', 'resolved', 'cancelled'],
  resolved: [],
  cancelled: [],
};

export interface Obligation {
  key: string;
  issues: [string, string];
  state: ObligationState;
  /** Why it exists: predicted overlap kind, forced-overlap actor etc. */
  evidence: Array<{ at: string; kind: string; detail: string }>;
  /** Set once materialized as a linked GitHub issue; never created twice. */
  githubIssue: number | null;
  /** Serial merge position: obligations are reconciled one at a time per repository, oldest first. */
  seq: number;
  repository: string;
  createdAt: string;
  updatedAt: string;
}

export type MergeOutcome =
  | { kind: 'clean-merge'; verification: 'passed' | 'failed' | 'not-run' }
  | { kind: 'textual-conflict'; paths: string[] }
  | { kind: 'semantic-conflict'; detail: string };

/** What the reconciler should do next for a merge outcome. Pure and deterministic. */
export function nextForOutcome(outcome: MergeOutcome): { state: ObligationState; needsIntegrationAgent: boolean; materializeIssue: boolean; reason: string } {
  switch (outcome.kind) {
    case 'clean-merge':
      if (outcome.verification === 'passed') return { state: 'resolved', needsIntegrationAgent: false, materializeIssue: false, reason: 'clean merge and verification passed' };
      if (outcome.verification === 'not-run') return { state: 'verifying', needsIntegrationAgent: false, materializeIssue: false, reason: 'clean merge; verification pending' };
      return { state: 'needs-agent', needsIntegrationAgent: true, materializeIssue: true, reason: 'merge was clean but verification failed (semantic conflict suspected)' };
    case 'textual-conflict':
      return { state: 'needs-agent', needsIntegrationAgent: true, materializeIssue: true, reason: `textual conflict in ${outcome.paths.length} file(s)` };
    case 'semantic-conflict':
      return { state: 'needs-agent', needsIntegrationAgent: true, materializeIssue: true, reason: outcome.detail };
  }
}

export class ObligationError extends Error {
  constructor(readonly code: 'not_found' | 'invalid_transition' | 'not_head', message: string) { super(message); this.name = 'ObligationError'; }
}

export class ObligationStore {
  private readonly db: SqlDatabase;
  constructor(options: { path: string }) {
    if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true });
    const Database = require('better-sqlite3') as new (p: string) => SqlDatabase;
    this.db = new Database(options.path);
    if (options.path !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS integration_obligations (
      key TEXT PRIMARY KEY, repository TEXT NOT NULL, issue_a TEXT NOT NULL, issue_b TEXT NOT NULL, state TEXT NOT NULL,
      evidence TEXT NOT NULL, github_issue INTEGER, seq INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS obligations_queue ON integration_obligations(repository, state, seq);`);
  }
  close(): void { this.db.close(); }

  private row(r: Record<string, unknown>): Obligation {
    return {
      key: r.key as string, repository: r.repository as string, issues: [r.issue_a as string, r.issue_b as string], state: r.state as ObligationState,
      evidence: JSON.parse(r.evidence as string) as Obligation['evidence'], githubIssue: (r.github_issue as number | null) ?? null,
      seq: r.seq as number, createdAt: r.created_at as string, updatedAt: r.updated_at as string,
    };
  }

  get(key: string): Obligation | null { const r = this.db.prepare('SELECT * FROM integration_obligations WHERE key = ?').get(key); return r ? this.row(r) : null; }

  /** Idempotent: an existing obligation only gains (deduplicated) evidence; state and seq are untouched. */
  ensure(repository: string, a: string, b: string, key: string, evidence: { kind: string; detail: string }, now = new Date().toISOString()): { obligation: Obligation; created: boolean } {
    const run = this.db.transaction(() => {
      const existing = this.get(key);
      if (existing) {
        if (!existing.evidence.some((e) => e.kind === evidence.kind && e.detail === evidence.detail)) {
          existing.evidence.push({ at: now, ...evidence });
          this.db.prepare('UPDATE integration_obligations SET evidence = ?, updated_at = ? WHERE key = ?').run(JSON.stringify(existing.evidence), now, key);
        }
        return { obligation: this.get(key)!, created: false };
      }
      const seq = Number(this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM integration_obligations WHERE repository = ?').get(repository.toLowerCase())!.n);
      const [x, y] = [a, b].sort() as [string, string];
      this.db.prepare('INSERT INTO integration_obligations (key, repository, issue_a, issue_b, state, evidence, github_issue, seq, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)')
        .run(key, repository.toLowerCase(), x, y, 'open', JSON.stringify([{ at: now, ...evidence }]), seq, now, now);
      return { obligation: this.get(key)!, created: true };
    });
    return run();
  }

  transition(key: string, to: ObligationState, evidence: { kind: string; detail: string }, now = new Date().toISOString()): Obligation {
    const run = this.db.transaction(() => {
      const o = this.get(key);
      if (!o) throw new ObligationError('not_found', `no obligation ${key}`);
      if (o.state === to) return o;
      if (!TRANSITIONS[o.state].includes(to)) throw new ObligationError('invalid_transition', `${o.state} -> ${to} is not allowed`);
      o.evidence.push({ at: now, ...evidence });
      this.db.prepare('UPDATE integration_obligations SET state = ?, evidence = ?, updated_at = ? WHERE key = ?').run(to, JSON.stringify(o.evidence), now, key);
      return this.get(key)!;
    });
    return run();
  }

  /** Record the materialized GitHub issue exactly once (a repeat with the same number is a no-op; a different one is refused). */
  linkGithubIssue(key: string, issueNumber: number, now = new Date().toISOString()): Obligation {
    const o = this.get(key);
    if (!o) throw new ObligationError('not_found', `no obligation ${key}`);
    if (o.githubIssue !== null && o.githubIssue !== issueNumber) throw new ObligationError('invalid_transition', `${key} is already linked to #${o.githubIssue}`);
    this.db.prepare('UPDATE integration_obligations SET github_issue = ?, updated_at = ? WHERE key = ?').run(issueNumber, now, key);
    return this.get(key)!;
  }

  /** Serial merge queue for a repository: the oldest non-terminal obligation is the only one that may be worked. */
  head(repository: string): Obligation | null {
    const r = this.db.prepare("SELECT * FROM integration_obligations WHERE repository = ? AND state NOT IN ('resolved','cancelled') ORDER BY seq LIMIT 1").get(repository.toLowerCase());
    return r ? this.row(r) : null;
  }
  queue(repository: string): Obligation[] {
    return this.db.prepare("SELECT * FROM integration_obligations WHERE repository = ? AND state NOT IN ('resolved','cancelled') ORDER BY seq").all(repository.toLowerCase()).map((r) => this.row(r));
  }

  /** Apply a merge attempt outcome to the head obligation only (serial merge). */
  applyOutcome(key: string, outcome: MergeOutcome, now = new Date().toISOString()): { obligation: Obligation; materializeIssue: boolean; needsIntegrationAgent: boolean } {
    const o = this.get(key);
    if (!o) throw new ObligationError('not_found', `no obligation ${key}`);
    const head = this.head(o.repository);
    if (head && head.key !== key) throw new ObligationError('not_head', `${key} is queued behind ${head.key}; merges are serial`);
    const next = nextForOutcome(outcome);
    let current = o;
    if (current.state === 'open' && next.state !== 'needs-agent') current = this.transition(key, 'merge-pending', { kind: 'merge-attempt', detail: 'merge started' }, now);
    if (current.state === 'merge-pending' && next.state === 'resolved') current = this.transition(key, 'verifying', { kind: 'merge', detail: 'clean merge' }, now);
    const updated = this.transition(key, next.state, { kind: outcome.kind, detail: next.reason }, now);
    return { obligation: updated, materializeIssue: next.materializeIssue && updated.githubIssue === null, needsIntegrationAgent: next.needsIntegrationAgent };
  }
}
