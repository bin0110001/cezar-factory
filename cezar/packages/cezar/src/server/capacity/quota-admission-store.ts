import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { cezarHomeDir, assertCezarHomeWriteIsSandboxed } from '../../paths.ts';
import {
  QuotaAdmissionController,
  type QuotaAdmissionSnapshot,
} from './quota-admission.ts';

const EMPTY: QuotaAdmissionSnapshot = { schemaVersion: 1, leases: [], deferred: [], cooldowns: [], failures: {} };

/** Cross-process serialized workspace ledger for quota leases and deferred admissions. */
export class QuotaAdmissionStore {
  constructor(private readonly path = join(cezarHomeDir(), 'quota-admission.json')) {}

  async transact<T>(operation: (controller: QuotaAdmissionController) => T | Promise<T>): Promise<T> {
    assertCezarHomeWriteIsSandboxed(this.path);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const guard = `${this.path}.guard`;
    await writeFile(guard, '', { encoding: 'utf8', mode: 0o600, flag: 'a' });
    const release = await lockfile.lock(guard, {
      lockfilePath: `${guard}.lock`,
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 40, minTimeout: 25, maxTimeout: 250 },
    });
    try {
      let snapshot: QuotaAdmissionSnapshot;
      try {
        snapshot = JSON.parse(await readFile(this.path, 'utf8')) as QuotaAdmissionSnapshot;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error(`quota admission state is unreadable; refusing dispatch: ${error instanceof Error ? error.message : String(error)}`);
        }
        snapshot = EMPTY;
      }
      const controller = new QuotaAdmissionController({}, snapshot);
      let value!: T;
      let failure: unknown;
      let failed = false;
      try { value = await operation(controller); } catch (error) { failed = true; failure = error; }
      const next = controller.snapshot();
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await rename(temp, this.path);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw new Error(`could not persist quota admission state: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (failed) throw failure;
      return value;
    } finally {
      await release();
    }
  }
}
