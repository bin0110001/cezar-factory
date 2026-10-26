import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';

const exec = promisify(execFile);
const gitIdentity = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
let bashAvailable = false;
const contract = {
  type: 'object',
  required: ['$cezar'],
  properties: {
    $cezar: {
      type: 'object', required: ['action', 'reasonCode'],
      properties: {
        action: { type: 'string', enum: ['no_work', 'skip_step', 'blocked'] },
        reasonCode: { type: 'string', enum: ['no_work', 'precondition_not_met', 'policy_blocked', 'dependency_unavailable', 'provider_quota', 'human_input_required'] },
      },
    },
  },
};

describe('workflow control outputs', () => {
  const roots: string[] = [];
  const managers: RunManager[] = [];
  const stores: RunStore[] = [];

  beforeAll(async () => {
    try {
      await exec('bash', ['-lc', 'true']);
      bashAvailable = true;
    } catch { bashAvailable = false; }
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const manager of managers.splice(0)) manager.dispose();
    for (const store of stores.splice(0)) store.flush();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  });

  async function runControl(action: 'no_work' | 'skip_step' | 'blocked', reasonCode: string, stepsAfter = false) {
    const repo = mkdtempSync(join(tmpdir(), 'cez-control-'));
    roots.push(repo);
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    writeFileSync(join(repo, 'seed.txt'), 'seed\n');
    await exec('git', ['add', '-A'], { cwd: repo });
    await exec('git', [...gitIdentity, 'commit', '-q', '-m', 'base'], { cwd: repo });
    const store = RunStore.open(join(repo, '.ai/cezar'));
    stores.push(store);
    const manager = new RunManager(store, repo);
    managers.push(manager);
    const tail = stepsAfter ? [{ id: 'tail', command: 'touch tail-ran' }] : [];
    const record = manager.startRun({
      name: 'control-fixture', source: 'file',
      steps: [
        {
          id: 'preflight', command: `printf '%s' '{"$cezar":{"action":"${action}","reasonCode":"${reasonCode}"}}'`,
          outputSchema: contract,
        },
        ...tail,
      ],
    }, { task: 'check workflow control', worktree: false });
    const deadline = Date.now() + 10_000;
    while (!['done', 'review', 'failed', 'cancelled'].includes(store.getRun(record.id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('workflow did not settle');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return { repo, run: store.getRun(record.id)! };
  }

  it.skipIf(!bashAvailable)('settles no-work and marks unvisited steps skipped', async () => {
    const { repo, run } = await runControl('no_work', 'no_work', true);
    expect(run.status, run.error).toBe('done');
    expect(run.outcome).toMatchObject({ kind: 'no_work', reasonCode: 'no_work', stepId: 'preflight' });
    expect(run.steps.map((step) => step.status)).toEqual(['done', 'skipped']);
    expect(existsSync(join(repo, 'tail-ran'))).toBe(false);
  });

  it.skipIf(!bashAvailable)('skips only its step and continues the chain', async () => {
    const { repo, run } = await runControl('skip_step', 'precondition_not_met', true);
    expect(run.status, run.error).toBe('done');
    expect(run.steps.map((step) => step.status)).toEqual(['skipped', 'done']);
    expect(existsSync(join(repo, 'tail-ran'))).toBe(true);
  });

  it.skipIf(!bashAvailable)('settles blocked with its stable reason code', async () => {
    const { run } = await runControl('blocked', 'provider_quota');
    expect(run.status).toBe('failed');
    expect(run.outcome).toMatchObject({ kind: 'blocked', reasonCode: 'provider_quota', stepId: 'preflight' });
  });
});
