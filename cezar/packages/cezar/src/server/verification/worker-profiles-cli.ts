import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  BUILTIN_WORKER_PROFILES,
  summarizeWorkerInventory,
  workerInventorySchema,
} from '@open-mercato/cezar-contract';

export interface WorkerProfilesCliIO {
  cwd?: string;
  now?: number;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

/** Read-only local inspection; inventory values and capability payloads are never printed. */
export async function runWorkerProfilesCommand(args: string[], io: WorkerProfilesCliIO = {}): Promise<number> {
  const stdout = io.stdout ?? ((text) => process.stdout.write(`${text}\n`));
  const stderr = io.stderr ?? ((text) => process.stderr.write(`${text}\n`));
  const [command, target, ...extra] = args;
  if (command === 'list' && !target && extra.length === 0) {
    stdout(JSON.stringify({ profiles: BUILTIN_WORKER_PROFILES.map(({ id, tags, allowedNetworkZones, maxConcurrency }) => ({ id, tags, allowedNetworkZones, maxConcurrency })) }, null, 2));
    return 0;
  }
  if (command !== 'inspect' || !target || extra.length > 0) {
    stderr('usage: cezar worker-profiles <list | inspect <inventory.json>>');
    return 2;
  }
  try {
    const file = resolve(io.cwd ?? process.cwd(), target);
    const parsed = workerInventorySchema.parse(JSON.parse(await readFile(file, 'utf8')));
    stdout(JSON.stringify(summarizeWorkerInventory(parsed, io.now), null, 2));
    return 0;
  } catch {
    // Parser and filesystem exceptions can include untrusted values; never echo them in inspection.
    stderr('worker inventory inspection failed: invalid JSON, unsupported schema, or unreadable file');
    return 1;
  }
}
