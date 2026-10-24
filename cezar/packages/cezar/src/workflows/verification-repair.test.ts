import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const roots: string[] = [];
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EBUSY') throw error; }
  }
});

async function fixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), `verification-repair-${label}-`));
  roots.push(root);
  mkdirSync(join(root, '.ai/factory'), { recursive: true });
  writeFileSync(join(root, '.ai/factory/factory.config.yaml'), `verification:\n  version: 1\n  checks:\n    unit:\n      runner: command\n      executable: ${JSON.stringify(process.execPath)}\n      args: ["-e", "process.stdout.write('assertion failed ' + 'x'.repeat(2000)); process.exit(require('fs').existsSync('fixed.txt') ? 0 : 1)"]\n      cwd: .\n      timeoutSeconds: 5\n      optional: false\n  suites:\n    full: [unit]\n`);
  await run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await run('git', [...GIT_ID, 'add', '-A'], { cwd: root });
  await run('git', [...GIT_ID, 'commit', '-q', '-m', 'fixture'], { cwd: root });
  const store = RunStore.open(join(root, '.ai/cezar'));
  const manager = new RunManager(store, root);
  return { root, store, manager };
}

async function settle(manager: RunManager, store: RunStore, id: string): Promise<void> {
  const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
  const internals = manager as unknown as { active: Map<string, unknown> };
  const deadline = Date.now() + 25_000;
  while (!terminal.has(store.getRun(id)?.status ?? '') || internals.active.has(id)) {
    if (Date.now() > deadline) throw new Error('verification repair workflow did not settle');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('verification repair workflow integration', () => {
  it('sends bounded triage to the agent and scopes the rerun to prior failed checks', async () => {
    const { root, store, manager } = await fixture('loop');
    const prompts: Array<string | null> = [];
    const managerInternals = manager as unknown as { runAgentStep: (...args: unknown[]) => Promise<string | null> };
    managerInternals.runAgentStep = async (...args: unknown[]) => {
      const triage = args[5] as string | null;
      prompts.push(triage);
      if (prompts.length === 2) writeFileSync(join(root, 'fixed.txt'), 'fixed\n');
      return null;
    };
    const workflow: WorkflowDef = { name: 'repair', source: 'file', steps: [
      { id: 'repair', prompt: '{{task}}' },
      { id: 'verify', verificationSuite: 'full', onFail: { retry: 'repair', max: 1 } },
    ] };
    try {
      const record = manager.startRun(workflow, { task: 'fix the failure', worktree: false });
      await settle(manager, store, record.id);
      expect(store.getRun(record.id)?.status, store.getRun(record.id)?.error).toBe('done');
      expect(store.getRun(record.id)?.steps.find((step) => step.id === 'repair')?.iterations).toBe(2);
      expect(prompts[1]).toContain('unit: failed');
      expect(prompts[1]!.length).toBeLessThanOrEqual(6_000);
      expect(prompts[1]).not.toContain('x'.repeat(1_000));
      const verificationEvents = store.readEvents(record.id).filter((event) => event.type === 'verification-result');
      const latest = verificationEvents.at(-1)!;
      const selection = JSON.parse(readFileSync(join(root, latest.selection as string), 'utf8'));
      expect(selection.mode).toBe('explicit');
      expect(selection.checks).toMatchObject([{ checkId: 'unit', status: 'selected' }]);
    } finally {
      manager.dispose();
      store.flush();
    }
  }, 30_000);

  it('stops when an agent changes verification history', async () => {
    const { root, store, manager } = await fixture('tamper');
    const managerInternals = manager as unknown as { runAgentStep: (...args: unknown[]) => Promise<string | null> };
    managerInternals.runAgentStep = async () => {
      writeFileSync(join(root, '.ai/cezar/verification-findings.json'), '{"version":1,"tampered":true}');
      return null;
    };
    const workflow: WorkflowDef = { name: 'tamper', source: 'file', steps: [{ id: 'repair', prompt: '{{task}}' }, { id: 'verify', verificationSuite: 'full' }] };
    try {
      const record = manager.startRun(workflow, { task: 'change history', worktree: false });
      await settle(manager, store, record.id);
      expect(store.getRun(record.id)?.status).toBe('failed');
      expect(store.getRun(record.id)?.error).toContain('historical evidence changed by an agent');
      expect(store.readEvents(record.id).filter((event) => event.type === 'verification-result')).toHaveLength(0);
    } finally {
      manager.dispose();
      store.flush();
    }
  }, 30_000);
});
