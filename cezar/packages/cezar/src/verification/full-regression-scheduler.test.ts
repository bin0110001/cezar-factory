import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectListEntry } from '@open-mercato/cezar-contract';
import { localTimeZone, nextOccurrence } from '@open-mercato/cezar-contract';
import { FullRegressionScheduler } from './full-regression-scheduler.ts';
import type { RunManager } from '../workflows/run.ts';
import type { RunStore } from '../runs/store.ts';

let temp = '';
afterEach(() => { if (temp) rmSync(temp, { recursive: true, force: true }); temp = ''; });

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
}

function commit(root: string, content: string, date?: Date): string {
  writeFileSync(join(root, 'source.txt'), `${content}\n`);
  git(root, 'add', 'source.txt');
  if (date) {
    execFileSync('git', ['commit', '-m', content], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, GIT_AUTHOR_DATE: date.toISOString(), GIT_COMMITTER_DATE: date.toISOString() },
    });
  } else git(root, 'commit', '-m', content);
  return git(root, 'rev-parse', 'HEAD');
}

function fixture(policy: ProjectListEntry['fullRegressionPolicy'], initialTime = Date.now()) {
  temp = mkdtempSync(join(tmpdir(), 'cezar-full-regression-'));
  const root = join(temp, 'project');
  mkdirSync(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Cezar test');
  git(root, 'config', 'user.email', 'cezar-test@example.invalid');
  const baseline = commit(root, 'baseline');
  const project = {
    id: 'cezar-factory', name: 'Cezar Factory', root,
    addedAt: new Date(0).toISOString(), lastOpenedAt: new Date(0).toISOString(),
    source: 'local' as const, status: 'ok' as const,
    ...(policy ? { fullRegressionPolicy: policy } : {}),
  } as ProjectListEntry;
  let now = initialTime;
  const runs = new Map<string, { id: string; status: string }>();
  const starts: Array<{ workflow: { steps: Array<{ command?: string }> }; input: { task: string; baseCommit?: string } }> = [];
  const manager = {
    resolveFactoryRelease: async () => undefined,
    canStartImmediately: () => true,
    startRun: (workflow: { steps: Array<{ command?: string }> }, input: { task: string; baseCommit?: string }) => {
      const run = { id: `run-${starts.length + 1}`, status: 'queued' };
      starts.push({ workflow, input });
      runs.set(run.id, run);
      return run;
    },
  } as unknown as RunManager;
  const store = { getRun: (id: string) => runs.get(id) } as unknown as RunStore;
  const scheduler = new FullRegressionScheduler({
    listProjects: async () => [project],
    context: async () => ({ root, manager, store }),
    now: () => now,
    stateDirectory: join(temp, 'scheduler-state'),
  });
  return { root, baseline, project, starts, runs, scheduler, setNow: (value: number) => { now = value; } };
}

describe('full regression scheduler', () => {
  it('leaves an unconfigured project on demand and pins a manual run to the clean HEAD', async () => {
    const test = fixture(undefined);
    await test.scheduler.start();
    test.scheduler.stop();
    expect(test.starts).toHaveLength(0);

    const result = await test.scheduler.runNow('cezar-factory');
    expect(result).toMatchObject({ status: 'queued', testedHead: test.baseline, followUpPending: false });
    expect(test.starts[0]?.input.baseCommit).toBe(test.baseline);
    expect(test.starts[0]?.workflow.steps[0]?.command).toContain('scripts/factory/test-full.ps1');
    const firstRun = test.runs.get('run-1');
    if (firstRun) firstRun.status = 'done';
    expect(await test.scheduler.runNow('cezar-factory')).toMatchObject({ status: 'limited' });
  });

  it('coalesces automatic checks until the configured number of commits has landed', async () => {
    const test = fixture({
      mode: 'after_changes', changesPerBatch: 2,
      windowHours: 168, maxRunsPerWindow: 3, maxUpdatesPerWindow: 50, maxQueuedRuns: 1,
    });
    await test.scheduler.start();
    commit(test.root, 'first change');
    await test.scheduler.tick();
    expect(test.starts).toHaveLength(0);

    const expectedHead = commit(test.root, 'second change');
    await test.scheduler.tick();
    test.scheduler.stop();
    expect(test.starts).toHaveLength(1);
    expect(test.starts[0]?.input.baseCommit).toBe(expectedHead);
  });

  it('runs scheduled projects only when their configured occurrence is due', async () => {
    const initialTime = Date.UTC(2026, 0, 1, 0, 30);
    const test = fixture({
      mode: 'scheduled', schedule: { type: 'hours', every: 1 },
      windowHours: 168, maxRunsPerWindow: 2, maxUpdatesPerWindow: 100, maxQueuedRuns: 1,
    }, initialTime);
    await test.scheduler.start();
    expect(test.starts).toHaveLength(0);

    const dueAt = nextOccurrence({ type: 'hours', every: 1 }, initialTime, localTimeZone());
    expect(dueAt).not.toBeNull();
    test.setNow(dueAt!);
    await test.scheduler.tick();
    test.scheduler.stop();
    expect(test.starts).toHaveLength(1);
    expect(test.starts[0]?.input.baseCommit).toBe(test.baseline);
  });

  it('keeps only the newest one-commit follow-up while a full suite is active', async () => {
    const test = fixture({
      mode: 'after_changes', changesPerBatch: 1,
      windowHours: 168, maxRunsPerWindow: 3, maxUpdatesPerWindow: 50, maxQueuedRuns: 1,
    });
    await test.scheduler.start();
    commit(test.root, 'run one');
    await test.scheduler.tick();
    expect(test.starts).toHaveLength(1);

    commit(test.root, 'intermediate follow-up');
    await test.scheduler.tick();
    const latestHead = commit(test.root, 'latest follow-up');
    await test.scheduler.tick();
    expect(test.starts).toHaveLength(1);

    const first = test.runs.get('run-1');
    if (first) first.status = 'done';
    await test.scheduler.tick();
    test.scheduler.stop();
    expect(test.starts).toHaveLength(2);
    expect(test.starts[1]?.input.baseCommit).toBe(latestHead);
  });

  it('preserves the newest coalesced head when limits change during an active run', async () => {
    const test = fixture({
      mode: 'after_changes', changesPerBatch: 1,
      windowHours: 168, maxRunsPerWindow: 4, maxUpdatesPerWindow: 20, maxQueuedRuns: 1,
    });
    await test.scheduler.start();
    commit(test.root, 'first run');
    await test.scheduler.tick();
    commit(test.root, 'queued follow-up');
    await test.scheduler.tick();
    const latestHead = commit(test.root, 'newest follow-up');
    test.project.fullRegressionPolicy = {
      mode: 'after_changes', changesPerBatch: 1,
      windowHours: 168, maxRunsPerWindow: 5, maxUpdatesPerWindow: 20, maxQueuedRuns: 1,
    };
    await test.scheduler.tick();

    const active = test.runs.get('run-1');
    if (active) active.status = 'done';
    await test.scheduler.tick();
    test.scheduler.stop();
    expect(test.starts).toHaveLength(2);
    expect(test.starts[1]?.input.baseCommit).toBe(latestHead);
  });

  it('keeps the rolling run cap when the project changes cadence', async () => {
    const test = fixture(undefined);
    const first = await test.scheduler.runNow('cezar-factory');
    expect(first.status).toBe('queued');
    const active = test.runs.get('run-1');
    if (active) active.status = 'done';

    test.project.fullRegressionPolicy = {
      mode: 'after_changes', changesPerBatch: 20,
      windowHours: 168, maxRunsPerWindow: 1, maxUpdatesPerWindow: 100, maxQueuedRuns: 1,
    };
    expect(await test.scheduler.runNow('cezar-factory')).toMatchObject({ status: 'limited' });
    expect(test.starts).toHaveLength(1);
  });

  it('keeps updates already counted when cadence changes, enforcing the new update cap', async () => {
    const test = fixture(undefined);
    const first = await test.scheduler.runNow('cezar-factory');
    expect(first.status).toBe('queued');
    const firstRun = test.runs.get('run-1');
    if (firstRun) firstRun.status = 'done';

    commit(test.root, 'first integrated update');
    test.project.fullRegressionPolicy = {
      mode: 'on-demand',
      windowHours: 168, maxRunsPerWindow: 5, maxUpdatesPerWindow: 1, maxQueuedRuns: 1,
    };
    expect((await test.scheduler.runNow('cezar-factory')).status).toBe('queued');
    const secondRun = test.runs.get('run-2');
    if (secondRun) secondRun.status = 'done';

    commit(test.root, 'second integrated update');
    test.project.fullRegressionPolicy = {
      mode: 'after_changes', changesPerBatch: 10,
      windowHours: 168, maxRunsPerWindow: 5, maxUpdatesPerWindow: 1, maxQueuedRuns: 1,
    };
    expect(await test.scheduler.runNow('cezar-factory')).toMatchObject({ status: 'limited' });
    expect(test.starts).toHaveLength(2);
  });

  it('counts updates when observed, even when imported commit timestamps predate the budget window', async () => {
    const initialTime = Date.UTC(2026, 9, 30, 12);
    const test = fixture({
      mode: 'after_changes', changesPerBatch: 1,
      windowHours: 24, maxRunsPerWindow: 5, maxUpdatesPerWindow: 1, maxQueuedRuns: 1,
    }, initialTime);
    await test.scheduler.start();
    const backdated = new Date(Date.UTC(2020, 0, 1));
    commit(test.root, 'first backdated update', backdated);
    await test.scheduler.tick();
    expect(test.starts).toHaveLength(1);

    const first = test.runs.get('run-1');
    if (first) first.status = 'done';
    commit(test.root, 'second backdated update', backdated);
    await test.scheduler.tick();
    test.scheduler.stop();
    expect(test.starts).toHaveLength(1);
  });
});
