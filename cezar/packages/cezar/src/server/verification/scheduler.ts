import type { LockRequest, Lease, ResourceLockManager } from './resource-locks.ts';
import { matchRequirements, type JobRequirements, type WorkerCapabilities } from './worker-capabilities.ts';
import { matchWorkerProfile, type WorkerInventory, type WorkerProfileMatch, type WorkerProfilePolicy, type WorkerProfileRequest } from '@open-mercato/cezar-contract';

export interface VerificationWorker {
  id: string;
  capabilities: WorkerCapabilities;
  /** Optional versioned inventory/policy; legacy local workers remain valid without it. */
  inventory?: WorkerInventory;
  profilePolicy?: WorkerProfilePolicy;
  activeJobs?: number;
  localTags?: string[];
  isLocal?: boolean;
}

export interface VerificationJob {
  id: string;
  requirements: JobRequirements;
  profileRequest?: WorkerProfileRequest;
  /** Extra locks the job needs beyond the derived display lock. */
  locks?: LockRequest[];
}

export type ScheduleResult =
  | { status: 'scheduled'; workerId: string; lease: Lease }
  | { status: 'unschedulable'; missing: string[]; reason?: Extract<WorkerProfileMatch, { schedulable: false }>['reason'] };

/** GUI jobs get one exclusive lock per display. */
export function deriveLocks(job: VerificationJob, workerId?: string, concurrencySlot?: number): LockRequest[] {
  const locks = [...(job.locks ?? [])];
  if (job.requirements.display) locks.push({ resource: `display:${job.requirements.display}`, mode: 'exclusive' });
  for (const lease of job.profileRequest?.leases ?? []) locks.push(lease);
  if (job.profileRequest && workerId && concurrencySlot !== undefined) {
    locks.push({ resource: `worker:${workerId}:concurrency:${concurrencySlot}`, mode: 'exclusive' });
  }
  return locks;
}

/**
 * Pick the first capable worker and wait for the job's locks. A job no worker
 * can run is reported unschedulable (with the closest worker's missing set)
 * and never waits. The caller must release (or let the TTL expire) the lease.
 */
export async function scheduleJob(
  job: VerificationJob,
  workers: VerificationWorker[],
  locks: ResourceLockManager,
  ttlMs?: number,
): Promise<ScheduleResult> {
  let best: string[] | null = null;
  let bestReason: Extract<WorkerProfileMatch, { schedulable: false }>['reason'] | undefined;
  const capable: Array<{ worker: VerificationWorker; preferenceScore: number }> = [];
  for (const w of workers) {
    const m = matchRequirements(w.capabilities, job.requirements);
    if (!m.schedulable) {
      if (!best || m.missing.length < best.length) { best = m.missing; bestReason = 'incompatible'; }
      continue;
    }
    if (job.profileRequest) {
      if (!w.inventory || !w.profilePolicy) {
        const missing = ['inventory:missing'];
        if (!best || missing.length < best.length) { best = missing; bestReason = 'incompatible'; }
        continue;
      }
      const profileMatch = matchWorkerProfile(w.inventory, job.profileRequest, w.profilePolicy, { isLocal: w.isLocal, localTags: w.localTags });
      if (!profileMatch.schedulable) {
        if (!best || profileMatch.missing.length < best.length) { best = profileMatch.missing; bestReason = profileMatch.reason; }
        continue;
      }
      capable.push({ worker: w, preferenceScore: profileMatch.preferenceScore });
    } else {
      const lease = await locks.acquire(`${w.id}:${job.id}`, deriveLocks(job), ttlMs);
      return { status: 'scheduled', workerId: w.id, lease };
    }
  }
  if (capable.length) {
    capable.sort((a, b) => b.preferenceScore - a.preferenceScore);
    for (const { worker } of capable) {
      const inventory = worker.inventory!;
      const policy = worker.profilePolicy!;
      const slots = Math.min(inventory.maxConcurrency, policy.maxConcurrency, job.profileRequest!.maxConcurrency ?? Number.MAX_SAFE_INTEGER);
      for (let slot = 0; slot < slots; slot++) {
        const lease = locks.tryAcquire(`${worker.id}:${job.id}`, deriveLocks(job, worker.id, slot), ttlMs);
        if (lease) return { status: 'scheduled', workerId: worker.id, lease };
      }
    }
    const selected = capable[0]!.worker;
    const lease = await locks.acquire(`${selected.id}:${job.id}`, deriveLocks(job, selected.id, 0), ttlMs);
    return { status: 'scheduled', workerId: selected.id, lease };
  }
  return {
    status: 'unschedulable',
    missing: best ?? Object.keys(job.requirements).filter((k) => job.requirements[k as keyof JobRequirements]),
    ...(job.profileRequest && bestReason ? { reason: bestReason } : {}),
  };
}
