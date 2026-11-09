import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { registerProject } from '../workspace/projects.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const exec = promisify(execFile);

describe('RunManager verification-suite integration', () => {
  it.skipIf(process.platform === 'win32')(
    'records the registered project identity in the verification artifact (Windows skipped: temp workspace stays locked after RunManager teardown)',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'cezar verification identity '));
      let store: RunStore | undefined;
      let manager: RunManager | undefined;
      try {
        mkdirSync(join(root, '.ai/factory'), { recursive: true });
        writeFileSync(join(root, '.ai/factory/factory.config.yaml'), [
          'verification:',
          '  version: 1',
          '  checks:',
          '    check:',
          '      runner: command',
          `      executable: ${JSON.stringify(process.execPath)}`,
          `      args: ${JSON.stringify(['-e', 'process.stdout.write("ok")'])}`,
          '      cwd: .',
          '      timeoutSeconds: 5',
          '      optional: false',
          '  suites:',
          '    quick: [check]',
          '',
        ].join('\n'));
        await exec('git', ['init', '-q', '-b', 'main'], { cwd: root });
        await exec('git', ['add', '.ai/factory/factory.config.yaml'], { cwd: root });
        await exec('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-q', '-m', 'fixture'], { cwd: root });

        store = RunStore.open(join(root, '.ai/cezar'));
        const project = await registerProject(root);
        manager = new RunManager(store, root, { projectId: project.id });
        const workflow: WorkflowDef = {
          name: 'verification',
          source: 'file',
          steps: [{ id: 'verify', name: 'Verify', verificationSuite: 'quick' }],
        };
        const record = manager.startRun(workflow, { task: 'run quick verification', worktree: true });
        const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
        const deadline = Date.now() + 20_000;
        while (!terminal.has(store.getRun(record.id)?.status ?? '')) {
          if (Date.now() > deadline) throw new Error('verification run did not finish in time');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        const event = store.readEvents(record.id).find((entry) => entry.type === 'verification-result');
        expect(event).toBeDefined();
        expect(store.getRun(record.id)?.status).toBe('done');
        const artifactPath = (event as unknown as { artifactPath: string }).artifactPath;
        const worktreePath = store.getRun(record.id)?.worktreePath;
        expect(worktreePath).toBeTruthy();
        const artifact = JSON.parse(readFileSync(join(worktreePath!, artifactPath), 'utf8')) as { projectId: string };
        expect(artifact.projectId).toBe(project.id);

        manager.dispose();
        manager = new RunManager(store, root, { projectId: project.id });
        const outsideWorktree = manager.startRun(workflow, { task: 'refuse verification outside a task worktree', worktree: false });
        const refusalDeadline = Date.now() + 20_000;
        while (!terminal.has(store.getRun(outsideWorktree.id)?.status ?? '')) {
          if (Date.now() > refusalDeadline) throw new Error('out-of-worktree verification run did not finish in time');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const outsideResult = store.readEvents(outsideWorktree.id).find((entry) => entry.type === 'verification-result') as unknown as { status: string; error: string } | undefined;
        expect(outsideResult?.status).toBe('infrastructure-error');
        expect(outsideResult?.error).toContain('worktree');

        manager.dispose();
        manager = new RunManager(store, root);
        const unregistered = manager.startRun(workflow, { task: 'refuse unregistered verification', worktree: false });
        const unregisteredDeadline = Date.now() + 20_000;
        while (!terminal.has(store.getRun(unregistered.id)?.status ?? '')) {
          if (Date.now() > unregisteredDeadline) throw new Error('unregistered verification run did not finish in time');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const unregisteredResult = store.readEvents(unregistered.id).find((entry) => entry.type === 'verification-result') as unknown as { status: string; error: string } | undefined;
        expect(unregisteredResult?.status).toBe('infrastructure-error');
        expect(unregisteredResult?.error).toContain('registered project');
      } finally {
        manager?.dispose();
        store?.flush();
        rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      }
    },
    30_000,
  );
});
