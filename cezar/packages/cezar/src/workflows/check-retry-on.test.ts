import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * `onFail.retryOn` — which exit codes buy the agent another attempt.
 *
 * A check that exits non-zero for reasons OTHER than the diff is the case this
 * exists for: `e2e` exits 1 on a failed test, 2 on a config or credential
 * error, 3 on an engine or model-provider failure. Without the gate every one
 * of them re-ran the implement step — a full agent session, and its tokens,
 * spent on a cause that is not in the worktree, once per `max`.
 *
 * Both tests here count AGENT SESSIONS through `notes.md`: the dry-run mock
 * appends one line per session, so the line count is how many times the
 * workflow looped back. Each test gets its own repo and manager (see the
 * DISPOSE note in `run.test.ts`).
 */
describe('onFail.retryOn gates the check retry loop by exit code', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-retry-on-'));
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    savedEnv.CEZ_MOCK_STDIN_FILE = process.env.CEZ_MOCK_STDIN_FILE;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(async () => {
    const active = manager as unknown as {
      active: Map<string, { session?: { result: Promise<unknown>; hardStop?(): void } }>;
    };
    for (const [id, entry] of active.active) {
      manager.cancel(id);
      if (!entry.session) continue;
      let settled = false;
      const result = entry.session.result.then(() => { settled = true; }, () => { settled = true; });
      await Promise.race([result, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      if (!settled) {
        entry.session.hardStop?.();
        await Promise.race([result, new Promise((resolve) => setTimeout(resolve, 1_000))]);
      }
    }
    manager.dispose();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    await rm(repoRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }, 30_000);

  const workflowFor = (retryOn: number[], exitCode = 2, category?: 'provider_quota' | 'test_regression'): WorkflowDef => ({
    name: 'implement-and-check',
    source: 'file',
    steps: [
      { id: 'implement', name: 'Implement', prompt: '{{task}}' },
      // `exit 2` stands for every "I could not run" code a richer check reports.
      {
        id: 'verify',
        name: 'Verify',
        command: `echo CONFIG_NOT_FOUND >&2; exit ${exitCode}`,
        onFail: { retry: 'implement', max: 2, retryOn },
        ...(category ? { failureReasons: { [String(exitCode)]: category } } : {}),
      },
    ],
  });

  const settle = async (id: string): Promise<void> => {
    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 20_000;
    while (!terminal.has(store.getRun(id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  it('fails the run on an unlisted exit code without re-running the agent', async () => {
    const record = manager.startRun(workflowFor([1]), {
      task: 'mock:done fix the login bug',
      worktree: false,
    });
    await settle(record.id);

    const finished = store.getRun(record.id);
    expect(finished?.status).toBe('failed');
    // The failure names the code and the gate, so the cockpit says WHY nothing retried.
    expect(finished?.error).toContain('exited 2');
    expect(finished?.error).toContain('retryOn');
    expect(finished?.steps.map((s) => ({ id: s.id, status: s.status, iterations: s.iterations }))).toEqual([
      { id: 'implement', status: 'done', iterations: 1 },
      { id: 'verify', status: 'failed', iterations: 1 },
    ]);
    // One agent session: the whole point is that exit 2 bought no second attempt.
    expect(readFileSync(join(repoRoot, 'notes.md'), 'utf8').trim().split('\n')).toHaveLength(1);
  }, 30_000);

  it('records an unknown route failure without replaying a preceding check or agent', async () => {
    const workflow: WorkflowDef = {
      name: 'route-effect',
      source: 'file',
      steps: [
        { id: 'implement', name: 'Implement', prompt: '{{task}}' },
        { id: 'validate', name: 'Validate result', command: 'exit 0' },
        { id: 'route', name: 'Apply lifecycle effect', command: 'echo REMOTE_FAILURE >&2; exit 1', failureReasons: { '1': 'unknown' } },
      ],
    };
    const record = manager.startRun(workflow, {
      task: 'mock:done fix the login bug',
      worktree: false,
    });
    await settle(record.id);

    const finished = store.getRun(record.id);
    expect(finished?.status).toBe('failed');
    expect(finished?.outcome).toMatchObject({ kind: 'infrastructure_failure', reasonCode: 'unknown', stepId: 'route' });
    expect(finished?.steps.map((step) => ({ id: step.id, status: step.status, iterations: step.iterations }))).toEqual([
      { id: 'implement', status: 'done', iterations: 1 },
      { id: 'validate', status: 'done', iterations: 1 },
      { id: 'route', status: 'failed', iterations: 1 },
    ]);
    expect(readFileSync(join(repoRoot, 'notes.md'), 'utf8').trim().split('\n')).toHaveLength(1);
  }, 30_000);

  it('still loops back on a listed exit code', async () => {
    const record = manager.startRun(workflowFor([2]), {
      task: 'mock:done fix the login bug',
      worktree: false,
    });
    await settle(record.id);

    const finished = store.getRun(record.id);
    expect(finished?.status).toBe('failed');
    expect(finished?.error).toContain('after 3 attempts');
    // The gate is a filter, not a switch: 2 is listed, so the loop ran its `max`.
    expect(finished?.steps.find((s) => s.id === 'implement')?.iterations).toBe(3);
    expect(readFileSync(join(repoRoot, 'notes.md'), 'utf8').trim().split('\n')).toHaveLength(3);
  }, 40_000);

  it('does not retry a classified provider failure even when retryOn lists its code', async () => {
    const record = manager.startRun(workflowFor([2], 2, 'provider_quota'), {
      task: 'mock:done fix the login bug',
      worktree: false,
    });
    await settle(record.id);

    const finished = store.getRun(record.id);
    expect(finished?.status).toBe('failed');
    expect(finished?.outcome).toMatchObject({
      kind: 'infrastructure_failure', reasonCode: 'provider_quota', stepId: 'verify',
    });
    expect(finished?.steps.map((step) => ({ id: step.id, status: step.status, iterations: step.iterations }))).toEqual([
      { id: 'implement', status: 'done', iterations: 1 },
      { id: 'verify', status: 'failed', iterations: 1 },
    ]);
    expect(readFileSync(join(repoRoot, 'notes.md'), 'utf8').trim().split('\n')).toHaveLength(1);
  }, 30_000);

  it('retries a classified test regression within budget and records the exhausted task outcome', async () => {
    const workflow = workflowFor([1], 1, 'test_regression');
    workflow.maxRepairAttempts = 2;
    workflow.maxRunDurationSeconds = 300;
    const changedFile = join(repoRoot, 'src', 'login.ts');
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(changedFile, 'pending repair\n');
    const stdinFile = join(repoRoot, 'mock-stdin.jsonl');
    process.env.CEZ_MOCK_STDIN_FILE = stdinFile;
    const record = manager.startRun(workflow, {
      task: 'mock:done fix the login bug',
      worktree: false,
    });
    await settle(record.id);

    const finished = store.getRun(record.id);
    expect(finished?.status).toBe('failed');
    expect(finished?.outcome).toMatchObject({
      kind: 'task_failure', reasonCode: 'test_regression', stepId: 'verify',
    });
    expect(finished?.steps.map((step) => ({ id: step.id, status: step.status, iterations: step.iterations }))).toEqual([
      { id: 'implement', status: 'done', iterations: 3 },
      { id: 'verify', status: 'failed', iterations: 3 },
    ]);
    expect(readFileSync(join(repoRoot, 'notes.md'), 'utf8').trim().split('\n')).toHaveLength(3);
    const retryNotes = store.readEvents(record.id)
      .filter((event) => event.type === 'note' && typeof event.message === 'string' && event.message.includes('retrying from "implement"'));
    expect(retryNotes.map((event) => String(event.message))).toEqual([
      'check failed — retrying from "implement" (attempt 1/2)',
      'check failed — retrying from "implement" (attempt 2/2)',
    ]);
    const prompts = readFileSync(stdinFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line).userText as string);
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toMatch(/Active workflow time remaining: \d+s\./);
    expect(prompts[0]).toContain('Shared repair budget: 0 of 2 attempts used; 2 remain.');
    expect(prompts[0]).toContain('Checks that can retry this agent: verify (up to 2 repairs).');
    expect(prompts[1]).toContain('Repair attempt 1 of 2 for check "verify" (exit 1).');
    expect(prompts[1]).toContain('Shared repair budget: 1 of 2 attempts used; 1 remain.');
    expect(prompts[1]).toMatch(/Active workflow time remaining: \d+s\./);
    expect(prompts[1]).toContain('login.ts');
    expect(prompts[1]).toContain('CONFIG_NOT_FOUND');
    expect(prompts[2]).toContain('Repair attempt 2 of 2 for check "verify" (exit 1).');
    expect(prompts[2]).toContain('Shared repair budget: 2 of 2 attempts used; 0 remain.');
  }, 40_000);

  it('shares and persists one repair budget across multiple check retry loops', async () => {
    const workflow: WorkflowDef = {
      name: 'shared-repair-budget',
      source: 'file',
      maxRepairAttempts: 2,
      steps: [
        { id: 'implement', name: 'Implement', prompt: '{{task}}' },
        {
          id: 'first-check',
          command: 'if [ ! -f .first-check-ran ]; then touch .first-check-ran; exit 1; fi; exit 0',
          onFail: { retry: 'implement', max: 2, retryOn: [1] },
        },
        {
          id: 'second-check',
          command: 'echo regression >&2; exit 1',
          onFail: { retry: 'implement', max: 2, retryOn: [1] },
        },
      ],
    };
    const record = manager.startRun(workflow, { task: 'mock:done repair budget', worktree: false });
    await settle(record.id);

    const finished = store.getRun(record.id);
    expect(finished?.status).toBe('failed');
    expect(finished?.outcome).toMatchObject({
      kind: 'blocked', reasonCode: 'attempt_budget_exhausted', stepId: 'second-check',
    });
    expect(finished?.repairAttemptsUsed).toBe(2);
    expect(finished?.steps.map((step) => step.iterations)).toEqual([3, 3, 2]);
    expect(readFileSync(join(repoRoot, 'notes.md'), 'utf8').trim().split('\n')).toHaveLength(3);

    store.flush();
    const reopenedStore = RunStore.open(join(repoRoot, '.ai/cezar'));
    expect(reopenedStore.getRun(record.id)?.repairAttemptsUsed).toBe(2);
  }, 40_000);
});
