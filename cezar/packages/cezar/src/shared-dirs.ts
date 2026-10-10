import { delimiter, resolve } from 'node:path';

/**
 * Directories an operator mounts into the server (not per project) and exposes through an env var,
 * e.g. `CEZ_SHARED_WORKFLOWS_DIRS=/projects/cezar-factory/workflows`. Entries are separated by the
 * platform path delimiter; blanks are ignored. Project-local files always win name collisions, so a
 * project can still override anything shared.
 */
export function sharedDirs(envName: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[envName];
  if (!raw) return [];
  return raw
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(entry));
}
