import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { fullRegressionPolicySchema, type FullRegressionPolicy, type ProjectListEntry } from '@open-mercato/cezar-contract';
import { localTimeZone, nextOccurrence } from '@open-mercato/cezar-contract';
import { factoryReleaseProvenance } from '../factory-release/resolver.ts';
import type { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';

export const FULL_REGRESSION_WORKFLOW = 'factory-full-regression';
const TICK_MS = 60_000;
const RUNNER = 'codex' as const;

const attemptSchema = z.object({
  runId: z.string(), sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  at: z.string().datetime(), trigger: z.enum(['scheduled', 'after_changes', 'on-demand']),
});
const updateSchema = z.object({ sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), at: z.string().datetime() });
const stateSchema = z.object({
  schemaVersion: z.literal(1), policyKey: z.string(), baselineSha: z.string(), lastObservedSha: z.string(),
  lastAttemptedSha: z.string().optional(), lastScheduledAt: z.string().datetime(),
  pendingHead: z.string().optional(), attempts: z.array(attemptSchema).max(500), updates: z.array(updateSchema).max(100_000),
  lastError: z.string().optional(),
});
type State = z.infer<typeof stateSchema>;

export interface FullRegressionContext {
  root: string;
  manager: RunManager;
  store: RunStore;
}

export interface FullRegressionSchedulerDeps {
  listProjects: () => Promise<readonly ProjectListEntry[]>;
  context: (projectId: string) => Promise<FullRegressionContext>;
  now?: () => number;
  warn?: (message: string) => void;
  /** Isolated scheduler-state root for tests; production state lives outside project Git trees. */
  stateDirectory?: string;
}

export type FullRegressionRunResult =
  | { status: 'queued' | 'running'; runId: string; testedHead: string; followUpPending: boolean }
  | { status: 'coalesced'; runId: string; testedHead: string; followUpPending: true }
  | { status: 'limited'; reason: string; retryAt?: string }
  | { status: 'not-configured'; reason: string };

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }).trim();
}

function headAndClean(root: string): { sha: string; clean: boolean } {
  const sha = git(root, 'rev-parse', '--verify', 'HEAD^{commit}');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) throw new Error('Git returned an invalid project HEAD');
  return { sha, clean: git(root, 'status', '--porcelain').length === 0 };
}

function policyKey(policy: FullRegressionPolicy): string {
  const schedule = policy.mode === 'scheduled' ? `${policy.schedule.type}:${policy.schedule.hour ?? 3}:${policy.schedule.minute ?? 0}:${policy.schedule.day ?? 1}:${policy.schedule.every ?? 6}` : '';
  const changes = policy.mode === 'after_changes' ? String(policy.changesPerBatch) : '';
  return [policy.mode, schedule, changes, policy.windowHours, policy.maxRunsPerWindow, policy.maxUpdatesPerWindow, policy.maxQueuedRuns].join('|');
}

function statePath(root: string, stateDirectory?: string): string {
  const key = createHash('sha256').update(resolve(root)).digest('hex');
  return join(stateDirectory ?? join(homedir(), '.cezar', 'verification'), key, 'full-regression-state.json');
}

function writeState(path: string, state: State): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, path);
}

function readState(path: string): State | undefined {
  if (!existsSync(path)) return undefined;
  return stateSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function withState<T>(root: string, fn: (path: string, current: State | undefined) => T, stateDirectory?: string): T {
  const path = statePath(root, stateDirectory);
  mkdirSync(dirname(path), { recursive: true });
  const guard = `${path}.guard`;
  if (!existsSync(guard)) writeFileSync(guard, '', { encoding: 'utf8', mode: 0o600 });
  const release = lockfile.lockSync(guard, { realpath: false, retries: 0 });
  try {
    return fn(path, readState(path));
  } finally {
    release();
  }
}

function activeRun(context: FullRegressionContext, attempts: State['attempts']): State['attempts'][number] | undefined {
  return [...attempts].reverse().find((attempt) => {
    if (!context.store.getRun(attempt.runId)) return false;
    return ['queued', 'running', 'waiting'].includes(context.store.getRun(attempt.runId)?.status ?? '');
  });
}

function updateCount(root: string, from: string, to: string): number {
  try { execFileSync('git', ['merge-base', '--is-ancestor', from, to], { cwd: root, timeout: 10_000, windowsHide: true, stdio: 'ignore' }); }
  catch { throw new Error(`cannot compare project HEAD ${to} with verification baseline ${from}; refusing to schedule full regression`); }
  return Number(git(root, 'rev-list', '--count', `${from}..${to}`)) || 0;
}

/**
 * Project-local full-suite scheduler. It reads only registered project entries, starts only for an
 * explicit scheduled/after_changes policy, pins each run to one integrated SHA, and leaves missing
 * policies on-demand. Updates observed while a run is active collapse into one latest-head follow-up.
 */
export class FullRegressionScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private stopped = true;
  private tickRunning = false;

  constructor(private readonly deps: FullRegressionSchedulerDeps) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.tick();
    if (!this.stopped && !this.timer) {
      this.timer = setInterval(() => void this.tick(), TICK_MS);
      this.timer.unref?.();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.stopped || this.tickRunning) return;
    this.tickRunning = true;
    try {
      for (const project of await this.deps.listProjects()) {
        const policy = project.fullRegressionPolicy;
        if (!policy || policy.mode === 'on-demand' || project.status === 'missing') continue;
        try { await this.runEligible(project, policy); }
        catch (error) { this.deps.warn?.(`[full-regression:${project.id}] ${error instanceof Error ? error.message : String(error)}`); }
      }
    } catch (error) {
      this.deps.warn?.(`[full-regression] project list refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.tickRunning = false;
    }
  }

  async runNow(projectId: string): Promise<FullRegressionRunResult> {
    let project: ProjectListEntry | undefined;
    try { project = (await this.deps.listProjects()).find((entry) => entry.id === projectId); }
    catch (error) { return { status: 'limited', reason: `project registry unavailable: ${error instanceof Error ? error.message : String(error)}` }; }
    if (!project) return { status: 'not-configured', reason: `unknown project: ${projectId}` };
    if (project.status === 'missing') return { status: 'not-configured', reason: 'project root is missing' };
    const parsed = fullRegressionPolicySchema.safeParse(project.fullRegressionPolicy ?? { mode: 'on-demand' });
    if (!parsed.success) return { status: 'not-configured', reason: 'full regression policy is invalid; configure it before scheduling work' };
    try { return await this.queue(project, parsed.data, 'on-demand'); }
    catch (error) { return { status: 'limited', reason: `full regression could not be scheduled: ${error instanceof Error ? error.message : String(error)}` }; }
  }

  private async runEligible(project: ProjectListEntry, policy: FullRegressionPolicy): Promise<void> {
    const context = await this.deps.context(project.id);
    const { sha, clean } = headAndClean(context.root);
    const nowMs = this.deps.now?.() ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const key = policyKey(policy);
    const path = statePath(context.root, this.deps.stateDirectory);
    const state = withState(context.root, (statePathValue, previous) => {
      let next = previous;
      if (!next) {
        next = {
          schemaVersion: 1, policyKey: key, baselineSha: sha, lastObservedSha: sha,
          lastScheduledAt: nowIso, attempts: [], updates: [],
        };
      } else if (next.policyKey !== key) {
        // Policy edits must not discard the batch baseline, coalesced newer head,
        // or rolling cost ledger. Commits since the last tick are counted below.
        next = { ...next, policyKey: key, lastScheduledAt: nowIso };
      }
      if (next.lastObservedSha !== sha) {
        const count = updateCount(context.root, next.lastObservedSha, sha);
        if (count > 0) {
          const log = git(context.root, 'log', '--format=%H:%ct', `${next.lastObservedSha}..${sha}`).split(/\r?\n/).filter(Boolean);
          for (const row of log) {
            const [updateSha, epoch] = row.split(':');
            if (updateSha && epoch && /^\d+$/.test(epoch)) next.updates.push({ sha: updateSha, at: new Date(Number(epoch) * 1000).toISOString() });
          }
        }
        next.lastObservedSha = sha;
      }
      const cutoff = nowMs - policy.windowHours * 60 * 60 * 1000;
      next.updates = next.updates.filter((item) => Date.parse(item.at) >= cutoff).slice(-100_000);
      next.attempts = next.attempts.filter((attempt) => Date.parse(attempt.at) >= cutoff).slice(-500);
      if (!clean) next.lastError = 'project checkout is dirty; waiting for a clean integrated commit';
      else delete next.lastError;
      writeState(statePathValue, next);
      return next;
    }, this.deps.stateDirectory);
    if (!clean) return;
    const active = activeRun(context, state.attempts);
    if (active) {
      if (policy.maxQueuedRuns > 0 && active.sha !== sha
        && state.attempts.length < policy.maxRunsPerWindow
        && state.updates.length <= policy.maxUpdatesPerWindow) {
        withState(context.root, (statePathValue, current) => {
          if (!current) return;
          current.pendingHead = sha;
          writeState(statePathValue, current);
        }, this.deps.stateDirectory);
      }
      return;
    }
    if (state.attempts.length >= policy.maxRunsPerWindow) return;
    if (state.updates.length > policy.maxUpdatesPerWindow) return;

    let due = state.pendingHead !== undefined && policy.maxQueuedRuns > 0;
    let trigger: 'scheduled' | 'after_changes' = policy.mode === 'scheduled' ? 'scheduled' : 'after_changes';
    if (policy.mode === 'scheduled') {
      const nextAt = nextOccurrence(policy.schedule, Date.parse(state.lastScheduledAt), localTimeZone());
      due ||= nextAt !== null && nextAt <= nowMs;
      trigger = 'scheduled';
    } else if (policy.mode === 'after_changes') {
      const baseline = state.lastAttemptedSha ?? state.baselineSha;
      const changes = baseline === sha ? 0 : updateCount(context.root, baseline, sha);
      due ||= changes >= policy.changesPerBatch;
      trigger = 'after_changes';
    }
    if (due && sha !== state.lastAttemptedSha) await this.queue(project, policy, trigger, context, sha);
  }

  private async queue(
    project: ProjectListEntry,
    policy: FullRegressionPolicy,
    trigger: 'scheduled' | 'after_changes' | 'on-demand',
    existingContext?: FullRegressionContext,
    capturedSha?: string,
  ): Promise<FullRegressionRunResult> {
    const context = existingContext ?? await this.deps.context(project.id);
    const { sha, clean } = headAndClean(context.root);
    const targetSha = capturedSha ?? sha;
    if (!clean) return { status: 'limited', reason: 'project checkout is dirty; full regression requires a clean integrated commit' };
    if (capturedSha && capturedSha !== sha) return { status: 'limited', reason: 'project HEAD moved before the verification could be queued; the next scheduler tick will use the newer head' };
    const nowMs = this.deps.now?.() ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const key = policyKey(policy);
    let factoryRelease: Awaited<ReturnType<RunManager['resolveFactoryRelease']>>;
    try { factoryRelease = await context.manager.resolveFactoryRelease(); }
    catch (error) { return { status: 'limited', reason: `Factory runtime unavailable: ${error instanceof Error ? error.message : String(error)}` }; }
    const result = withState(context.root, (path, previous) => {
      const current = previous ?? {
        schemaVersion: 1 as const, policyKey: key, baselineSha: targetSha, lastObservedSha: targetSha,
        lastScheduledAt: nowIso, attempts: [], updates: [],
      };
      if (current.policyKey !== key) {
        current.policyKey = key;
      }
      const cutoff = nowMs - policy.windowHours * 60 * 60 * 1000;
      current.attempts = current.attempts.filter((attempt) => Date.parse(attempt.at) >= cutoff).slice(-500);
      current.updates = current.updates.filter((item) => Date.parse(item.at) >= cutoff).slice(-100_000);
      if (current.lastObservedSha !== targetSha) {
        const count = updateCount(context.root, current.lastObservedSha, targetSha);
        if (count > 0) {
          const log = git(context.root, 'log', '--format=%H:%ct', `${current.lastObservedSha}..${targetSha}`).split(/\r?\n/).filter(Boolean);
          for (const row of log) {
            const [updateSha, epoch] = row.split(':');
            if (updateSha && epoch && /^\d+$/.test(epoch)) current.updates.push({ sha: updateSha, at: new Date(Number(epoch) * 1000).toISOString() });
          }
        }
        current.lastObservedSha = targetSha;
      }
      const active = activeRun(context, current.attempts);
      if (active) {
        if (active.sha === targetSha) {
          return { state: current, result: { status: 'queued' as const, runId: active.runId, testedHead: active.sha, followUpPending: current.pendingHead !== undefined } };
        }
        if (policy.maxQueuedRuns === 0) return { state: current, result: { status: 'limited' as const, reason: 'a full regression run is active and this policy allows no queued follow-up' } };
        if (current.attempts.length >= policy.maxRunsPerWindow) return { state: current, result: { status: 'limited' as const, reason: 'maximum full regression runs for this window reached' } };
        if (current.updates.length > policy.maxUpdatesPerWindow) return { state: current, result: { status: 'limited' as const, reason: 'maximum project updates for this window reached' } };
        current.pendingHead = targetSha;
        writeState(path, current);
        return { state: current, result: { status: 'coalesced' as const, runId: active.runId, testedHead: active.sha, followUpPending: true as const } };
      }
      if (current.attempts.length >= policy.maxRunsPerWindow) {
        const retryAt = new Date(Math.min(...current.attempts.map((attempt) => Date.parse(attempt.at))) + policy.windowHours * 60 * 60 * 1000).toISOString();
        return { state: current, result: { status: 'limited' as const, reason: 'maximum full regression runs for this window reached', retryAt } };
      }
      if (current.updates.length > policy.maxUpdatesPerWindow) {
        return { state: current, result: { status: 'limited' as const, reason: 'maximum project updates for this window reached' } };
      }
      if (policy.maxQueuedRuns === 0 && !context.manager.canStartImmediately()) {
        return { state: current, result: { status: 'limited' as const, reason: 'project is at its active task cap and this policy allows no queued regression run' } };
      }
      const workflow: WorkflowDef = {
        name: FULL_REGRESSION_WORKFLOW,
        description: 'Run the configured full regression suite for one immutable integrated project commit.',
        source: 'built-in',
        ...(factoryRelease ? { factoryRelease: factoryReleaseProvenance(factoryRelease) } : {}),
        steps: [{
          id: 'full-regression',
          name: 'Run full regression suite',
          command: 'pwsh -NoProfile -File $FACTORY_RUNTIME_ROOT/scripts/factory/test-full.ps1 -Task "{{task}}"',
        }],
      };
      const task = `Full regression for project ${project.id} at head ${targetSha} (trigger: ${trigger}). Record selected checks, deferred checks, and the exact tested commit.`;
      const run = context.manager.startRun(workflow, { task, runner: RUNNER, worktree: true, baseCommit: targetSha, skipAutoName: true });
      current.attempts.push({ runId: run.id, sha: targetSha, at: nowIso, trigger });
      current.lastAttemptedSha = targetSha;
      if (trigger === 'scheduled') current.lastScheduledAt = nowIso;
      current.pendingHead = undefined;
      current.policyKey = key;
      writeState(path, current);
      return { state: current, result: { status: run.status === 'running' ? 'running' as const : 'queued' as const, runId: run.id, testedHead: targetSha, followUpPending: false } };
    }, this.deps.stateDirectory);
    if (result.result.status === 'limited' || result.result.status === 'coalesced') return result.result;
    return result.result;
  }
}
