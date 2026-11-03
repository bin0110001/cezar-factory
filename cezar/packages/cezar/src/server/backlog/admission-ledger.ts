import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

interface SqlStatement { run(...p: unknown[]): { changes: number }; get(...p: unknown[]): Record<string, unknown> | undefined; all(...p: unknown[]): Record<string, unknown>[] }
interface SqlDatabase { exec(sql: string): void; prepare(sql: string): SqlStatement; pragma(s: string): unknown; transaction<T extends (...a: never[]) => unknown>(fn: T): T; close(): void }
const require = createRequire(import.meta.url);

export type ReserveResult =
  | { ok: true; replay: boolean; token: string }
  | { ok: false; reason: 'held' | 'capacity'; holder?: string };

/**
 * Atomic admission (#198): per-issue claim plus a capacity reservation in ONE immediate
 * transaction, so concurrent scheduler processes cannot double-dispatch or over-reserve.
 *
 * Honest scope: this is a local SQLite file, so it gives mutual exclusion between processes on one
 * host. Multi-host mutual exclusion needs the designated coordinator (#197 degraded-mode flag).
 *
 * Leases expire (`ttlMs`), so a crashed holder cannot pin an issue or a slot forever. A repeat
 * `reserve` by the same holder is an idempotent replay and refreshes the lease.
 */
export class AdmissionLedger {
  private readonly db: SqlDatabase;
  constructor(options: { path: string }) {
    if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true });
    const Database = require('better-sqlite3') as new (p: string) => SqlDatabase;
    this.db = new Database(options.path);
    if (options.path !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS admissions (
      issue TEXT PRIMARY KEY, holder TEXT NOT NULL, token TEXT NOT NULL, decision_key TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
  }

  close(): void { this.db.close(); }

  reserve(issue: string, holder: string, decisionKey: string, options: { maxActive: number; ttlMs: number; now: number }): ReserveResult {
    const tx = this.db.transaction((): ReserveResult => {
      // BEGIN IMMEDIATE semantics come from the transaction wrapper below.
      const row = this.db.prepare('SELECT * FROM admissions WHERE issue = ?').get(issue);
      const live = row && (row.expires_at as number) > options.now;
      if (live && row!.holder === holder) {
        this.db.prepare('UPDATE admissions SET expires_at = ? WHERE issue = ?').run(options.now + options.ttlMs, issue);
        return { ok: true, replay: true, token: row!.token as string };
      }
      if (live) return { ok: false, reason: 'held', holder: row!.holder as string };
      this.db.prepare('DELETE FROM admissions WHERE expires_at <= ?').run(options.now);
      const active = Number(this.db.prepare('SELECT COUNT(*) AS n FROM admissions').get()!.n);
      if (active >= options.maxActive) return { ok: false, reason: 'capacity' };
      const token = `${holder}:${options.now}:${Math.random().toString(36).slice(2, 10)}`;
      this.db.prepare('INSERT INTO admissions (issue, holder, token, decision_key, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(issue, holder, token, decisionKey, options.now + options.ttlMs, options.now);
      return { ok: true, replay: false, token };
    });
    // better-sqlite3 transactions are DEFERRED by default; `.immediate` takes the write lock up front.
    const immediate = (tx as unknown as { immediate?: () => ReserveResult }).immediate;
    return immediate ? immediate.call(tx) : tx();
  }

  /** Compare-and-set release: only the current token holder may release. Returns whether a row was removed. */
  release(issue: string, token: string): boolean {
    return this.db.prepare('DELETE FROM admissions WHERE issue = ? AND token = ?').run(issue, token).changes > 0;
  }

  active(now: number): { issue: string; holder: string; expiresAt: number }[] {
    return this.db.prepare('SELECT issue, holder, expires_at FROM admissions WHERE expires_at > ? ORDER BY issue').all(now)
      .map((r) => ({ issue: r.issue as string, holder: r.holder as string, expiresAt: r.expires_at as number }));
  }
}
