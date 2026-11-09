import type { LockRequest, Lease, ResourceLockManager } from './resource-locks.ts';
import { matchRequirements, type JobRequirements, type WorkerCapabilities } from './worker-capabilities.ts';

export interface VerificationWorker {
  id: string;
  capabilities: WorkerCapabilities;
}

export interface VerificationJob {
  id: string;
  requirements: JobRequirements;
  /** Extra locks the job needs beyond the derived display lock. */
  locks?: LockRequest[];
}

export type ScheduleResult =
  | { status: 'scheduled'; workerId: string; lease: Lease }
  | { status: 'unschedulable'; missing: string[] };

/** GUI jobs get one exclusive lock per display. */
export function deriveLocks(job: VerificationJob): LockRequest[] {
  const locks = [...(job.locks ?? [])];
  if (job.requirements.display) locks.push({ resource: `display:${job.requirements.display}`, mode: 'exclusive' });
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
  for (const w of workers) {
    const m = matchRequirements(w.capabilities, job.requirements);
    if (m.schedulable) {
      const lease = await locks.acquire(`${w.id}:${job.id}`, deriveLocks(job), ttlMs);
      return { status: 'scheduled', workerId: w.id, lease };
    }
    if (!best || m.missing.length < best.length) best = m.missing;
  }
  return {
    status: 'unschedulable',
    missing: best ?? Object.keys(job.requirements).filter((k) => job.requirements[k as keyof JobRequirements]),
  };
}
