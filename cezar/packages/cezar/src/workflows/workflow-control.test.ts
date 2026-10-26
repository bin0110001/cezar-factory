import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';

const exec = promisify(execFile);
const gitIdentity = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
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

  afterEach(async () => {
    for (const manager of managers.splice(0)) manager.dispose();
    for (const store of stores.splice(0)) store.flush();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
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
    const internal = manager as unknown as {
      runCheckStep: (_state: unknown, step: { id: string }) => Promise<{
        ok: boolean; output: string; exitCode: number; structuredOutput?: unknown;
        control?: { action: 'no_work' | 'skip_step' | 'blocked'; reasonCode: string };
      }>;
    };
    internal.runCheckStep = async (_state, step) => {
      if (step.id === 'preflight') {
        return { ok: true, output: '{}', exitCode: 0, structuredOutput: { $cezar: { action, reasonCode } }, control: { action, reasonCode } };
      }
      writeFileSync(join(repo, 'tail-ran'), 'ran\n');
      return { ok: true, output: 'passed', exitCode: 0 };
    };
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

  async function runInvalidOutput(reason: 'output_missing' | 'output_malformed' | 'output_invalid') {
    const repo = mkdtempSync(join(tmpdir(), 'cez-invalid-output-'));
    roots.push(repo);
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    writeFileSync(join(repo, 'seed.txt'), 'seed\n');
    await exec('git', ['add', '-A'], { cwd: repo });
    await exec('git', [...gitIdentity, 'commit', '-q', '-m', 'base'], { cwd: repo });
    const store = RunStore.open(join(repo, '.ai/cezar'));
    stores.push(store);
    const manager = new RunManager(store, repo);
    managers.push(manager);
    const internal = manager as unknown as {
      runCheckStep: (_state: unknown, step: { id: string }) => Promise<{
        ok: boolean; output: string; exitCode: number; contractError?: boolean;
        contractFailureReason?: 'output_missing' | 'output_malformed' | 'output_invalid';
      }>;
    };
    internal.runCheckStep = async (_state, step) => step.id === 'preflight'
      ? { ok: false, output: 'invalid structured output', exitCode: 1, contractError: true, contractFailureReason: reason }
      : { ok: true, output: 'should not execute', exitCode: 0 };
    const record = manager.startRun({
      name: 'invalid-output-fixture', source: 'file',
      steps: [
        {
          id: 'preflight', command: 'preflight',
          outputSchema: { type: 'object', required: ['count'], properties: { count: { type: 'integer' } } },
        },
        { id: 'consumer', command: 'touch consumer-ran' },
      ],
    }, { task: 'reject invalid structured output', worktree: false });
    const deadline = Date.now() + 10_000;
    while (!['done', 'review', 'failed', 'cancelled'].includes(store.getRun(record.id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('invalid-output workflow did not settle');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return { repo, run: store.getRun(record.id)! };
  }

  async function runConcurrentOutputs() {
    const repo = mkdtempSync(join(tmpdir(), 'cez-concurrent-output-'));
    roots.push(repo);
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    writeFileSync(join(repo, 'seed.txt'), 'seed\n');
    await exec('git', ['add', '-A'], { cwd: repo });
    await exec('git', [...gitIdentity, 'commit', '-q', '-m', 'base'], { cwd: repo });
    const store = RunStore.open(join(repo, '.ai/cezar'));
    stores.push(store);
    const manager = new RunManager(store, repo, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 2 } }) });
    managers.push(manager);
    const consumed: Record<string, unknown> = {};
    let activeCollectors = 0;
    let peakConcurrentCollectors = 0;
    const internal = manager as unknown as {
      runCheckStep: (_state: unknown, step: { id: string }, task: string, input: { outputs: Record<string, unknown> }) => Promise<{
        ok: boolean; output: string; exitCode: number; structuredOutput?: unknown;
      }>;
    };
    internal.runCheckStep = async (_state, step, task, input) => {
      if (step.id === 'collect') {
        activeCollectors++;
        peakConcurrentCollectors = Math.max(peakConcurrentCollectors, activeCollectors);
        try {
          await new Promise((resolve) => setTimeout(resolve, task.endsWith('alpha') ? 40 : 10));
          return { ok: true, output: '{}', exitCode: 0, structuredOutput: { owner: task } };
        } finally {
          activeCollectors--;
        }
      }
      consumed[task] = input.outputs.collect;
      return { ok: true, output: 'consumed', exitCode: 0 };
    };
    const workflow = {
      name: 'concurrent-output-fixture', source: 'file' as const,
      steps: [
        { id: 'collect', command: 'collect', outputSchema: { type: 'object' } },
        { id: 'consume', command: 'consume' },
      ],
    };
    const records = ['alpha', 'beta'].map((name) => manager.startRun(workflow, { task: `run-${name}`, worktree: true }));
    const deadline = Date.now() + 10_000;
    while (records.some((record) => !['done', 'review', 'failed', 'cancelled'].includes(store.getRun(record.id)?.status ?? ''))) {
      if (Date.now() > deadline) throw new Error('concurrent output workflows did not settle');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return { consumed, records: records.map((record) => store.getRun(record.id)), peakConcurrentCollectors };
  }

  it('settles no-work and marks unvisited steps skipped', async () => {
    const { repo, run } = await runControl('no_work', 'no_work', true);
    expect(run.status, run.error).toBe('done');
    expect(run.outcome).toMatchObject({ kind: 'no_work', reasonCode: 'no_work', stepId: 'preflight' });
    expect(run.steps.map((step) => step.status)).toEqual(['done', 'skipped']);
    expect(existsSync(join(repo, 'tail-ran'))).toBe(false);
  });

  it('skips only its step and continues the chain', async () => {
    const { repo, run } = await runControl('skip_step', 'precondition_not_met', true);
    expect(run.status, run.error).toBe('done');
    expect(run.steps.map((step) => step.status)).toEqual(['skipped', 'done']);
    expect(existsSync(join(repo, 'tail-ran'))).toBe(true);
  });

  it('records a terminal skipped outcome when every work step is skipped', async () => {
    const { run } = await runControl('skip_step', 'precondition_not_met');
    expect(run.status).toBe('done');
    expect(run.outcome).toMatchObject({ kind: 'skipped', reasonCode: 'precondition_not_met', stepId: 'preflight' });
    expect(run.steps.map((step) => step.status)).toEqual(['skipped']);
  });

  it('settles blocked with its stable reason code', async () => {
    const { run } = await runControl('blocked', 'provider_quota');
    expect(run.status).toBe('failed');
    expect(run.outcome).toMatchObject({ kind: 'blocked', reasonCode: 'provider_quota', stepId: 'preflight' });
  });

  it('rejects missing, malformed, and schema-invalid output before downstream dispatch', async () => {
    const cases = [
      'output_missing',
      'output_malformed',
      'output_invalid',
    ] as const;
    for (const reason of cases) {
      const { repo, run } = await runInvalidOutput(reason);
      expect(run.status, run.error).toBe('failed');
      expect(run.outcome).toMatchObject({ kind: 'contract_failure', reasonCode: reason, stepId: 'preflight' });
      expect(run.steps.map((step) => step.status)).toEqual(['failed', 'pending']);
      expect(existsSync(join(repo, 'consumer-ran'))).toBe(false);
    }
  });

  it('keeps validated outputs scoped to each concurrent run', async () => {
    const { consumed, records, peakConcurrentCollectors } = await runConcurrentOutputs();
    expect(consumed).toEqual({
      'run-alpha': { owner: 'run-alpha' },
      'run-beta': { owner: 'run-beta' },
    });
    expect(peakConcurrentCollectors).toBe(2);
    expect(records.map((record) => record?.status)).toEqual(['done', 'done']);
  });
});
