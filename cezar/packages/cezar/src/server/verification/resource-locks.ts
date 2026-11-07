/**
 * Lease-based resource locks with exclusive/shared modes and TTL (#112).
 * In-memory only; the clock is injectable. Waiters are served FIFO, and a
 * waiting exclusive request blocks later shared requests (no starvation).
 */

export type LockMode = 'exclusive' | 'shared';
export interface LockRequest {
  resource: string;
  mode: LockMode;
}
export interface Lease {
  id: number;
  owner: string;
  locks: LockRequest[];
  expiresAt: number;
}

export interface LockManagerOptions {
  now?: () => number;
  defaultTtlMs?: number;
}

export class ResourceLockManager {
  private readonly now: () => number;
  private readonly defaultTtlMs: number;
  private leases = new Map<number, Lease>();
  private waiters: Array<{ owner: string; locks: LockRequest[]; ttlMs: number; resolve: (l: Lease) => void }> = [];
  private nextId = 1;

  constructor(opts: LockManagerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.defaultTtlMs = opts.defaultTtlMs ?? 30_000;
  }

  /** Drop expired leases (crashed holders) and admit any waiters that now fit. */
  sweep(): void {
    const t = this.now();
    for (const [id, l] of this.leases) if (l.expiresAt <= t) this.leases.delete(id);
    this.admit();
  }

  /** Try to acquire all locks atomically; returns null when contended. */
  tryAcquire(owner: string, locks: LockRequest[], ttlMs = this.defaultTtlMs): Lease | null {
    this.sweep();
    // Honor FIFO: do not barge past waiters that conflict with us.
    if (this.waiters.some((w) => conflicts(w.locks, locks))) return null;
    return this.grant(owner, locks, ttlMs);
  }

  /** Resolve once all locks are held. Re-checked on release/expiry via sweep(). */
  acquire(owner: string, locks: LockRequest[], ttlMs = this.defaultTtlMs): Promise<Lease> {
    const lease = this.tryAcquire(owner, locks, ttlMs);
    if (lease) return Promise.resolve(lease);
    return new Promise((resolve) => this.waiters.push({ owner, locks, ttlMs, resolve }));
  }

  renew(leaseId: number, ttlMs = this.defaultTtlMs): boolean {
    this.sweep();
    const l = this.leases.get(leaseId);
    if (!l) return false;
    l.expiresAt = this.now() + ttlMs;
    return true;
  }

  release(leaseId: number): boolean {
    const ok = this.leases.delete(leaseId);
    this.sweep();
    return ok;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  private grant(owner: string, locks: LockRequest[], ttlMs: number): Lease | null {
    for (const l of this.leases.values()) if (conflicts(l.locks, locks)) return null;
    const lease: Lease = { id: this.nextId++, owner, locks, expiresAt: this.now() + ttlMs };
    this.leases.set(lease.id, lease);
    return lease;
  }

  private admit(): void {
    const stillWaiting: typeof this.waiters = [];
    for (const w of this.waiters) {
      // A waiter earlier in the queue that conflicts keeps this one behind it.
      const blockedByEarlier = stillWaiting.some((e) => conflicts(e.locks, w.locks));
      const lease = blockedByEarlier ? null : this.grant(w.owner, w.locks, w.ttlMs);
      if (lease) w.resolve(lease);
      else stillWaiting.push(w);
    }
    this.waiters = stillWaiting;
  }
}

function conflicts(a: LockRequest[], b: LockRequest[]): boolean {
  return a.some((x) => b.some((y) => x.resource === y.resource && (x.mode === 'exclusive' || y.mode === 'exclusive')));
}
