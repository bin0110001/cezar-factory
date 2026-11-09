import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sharedBacklogStore } from './admission-hook.ts';
import { backlogSchedulingMode } from './admission-hook.ts';
import { syncOpenIssues, type GhRunner, type SyncOutcome } from './github-sync.ts';

/**
 * Scheduled GitHub reconciliation (#193). Off unless backlog scheduling is on AND
 * `CEZAR_BACKLOG_SYNC=on`: the sync writes the backlog block into issue bodies, so it is a separate,
 * explicit opt-in from shadow/enforce scheduling. Single-flight per process; one project's failure
 * never stops the others.
 */
export const BACKLOG_SYNC_INTERVAL_MS = 10 * 60_000;

export function backlogSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return backlogSchedulingMode(env) !== 'off' && (env.CEZAR_BACKLOG_SYNC ?? '').trim().toLowerCase() === 'on';
}

export interface SyncProject { root: string; github?: { owner: string; repo: string } | undefined }

export function ghRunnerFor(root: string): GhRunner {
  const run = promisify(execFile);
  return async (args) => (await run('gh', args, { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true })).stdout.trim();
}

let inFlight = false;

/** One pass over all projects. Returns per-repository outcomes; resolves quietly if a pass is already running. */
export async function runBacklogSyncOnce(projects: Iterable<SyncProject>, options: { env?: NodeJS.ProcessEnv; gh?: (root: string) => GhRunner; log?: (message: string) => void } = {}): Promise<Record<string, SyncOutcome[]> | 'skipped'> {
  if (!backlogSyncEnabled(options.env) || inFlight) return 'skipped';
  inFlight = true;
  const results: Record<string, SyncOutcome[]> = {};
  try {
    const store = await sharedBacklogStore();
    for (const project of projects) {
      if (!project.github) continue;
      const repository = `${project.github.owner}/${project.github.repo}`;
      try {
        results[repository] = await syncOpenIssues({ store, repository, gh: (options.gh ?? ghRunnerFor)(project.root) });
        const counts: Record<string, number> = {};
        for (const r of results[repository]!) counts[r.status] = (counts[r.status] ?? 0) + 1;
        options.log?.(`[backlog-sync] ${repository} ${JSON.stringify(counts)}`);
      } catch (error) {
        options.log?.(`[backlog-sync] ${repository} failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`);
      }
    }
    return results;
  } finally { inFlight = false; }
}
