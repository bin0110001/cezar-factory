import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PENDING_ASK_MAX_QUESTIONS, versionedWorkflowSchema, type DispatchInput, type DispatchJoin, type RunDispatch } from '@open-mercato/cezar-contract';
import { runRecordSchema, RunStore, type RunRecord } from '../runs/store.ts';
import { WorkspaceSemaphore, type WorkspaceResourceLimits } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';
import { evaluateDispatchJoin } from '../dispatch/engine.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Task dispatch's ENGINE (spec `.ai/specs/2026-09-10-dispatch.md`), driven end to end through the
 * dry-run mock: a task that dispatches, refusals that are answers rather than crashes, the budget
 * brakes, the cancel cascade, the settle→parent report, the tree directory, and the Guard.
 *
 * Everything here is gated twice — dispatch on (the default) AND a `dispatch` on the record — so the last
 * describe block is the counterweight: the same turns on a run with no `dispatch` must behave
 * exactly as they did before this feature existed.
 *
 * The runs are real: real worktrees off a real temp repository, because the fork point IS the
 * feature and a `worktree: false` fixture could not observe it.
 */
describe('the dispatch engine (spec 2026-09-10-dispatch)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const started: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  const SINGLE_STEP: WorkflowDef = {
    name: '(planned)',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-dispatch-'));
    for (const key of ['CEZ_DRY_RUN', 'CEZ_DISPATCH']) savedEnv[key] = process.env[key];
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_DISPATCH = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = boot();
    started.length = 0;
  });

  it('persists the workflow definition pin with the initial run and rejects later changes', () => {
    const workflow: WorkflowDef = { name: 'pinned', source: 'built-in', steps: [{ id: 'task', prompt: 'do it' }] };
    const record = manager.startRun(workflow, { task: 'pinned run', worktree: false });
    const persisted = store.getRun(record.id);
    expect(persisted?.workflowDefinitionPin).toMatchObject({ format: 'legacy', id: 'pinned' });
    expect(persisted?.workflowDef).toEqual(workflow);
    expect(() => store.updateRun(record.id, { workflowDefinitionPin: { ...persisted!.workflowDefinitionPin!, digest: '0'.repeat(64) } })).toThrow(/immutable/);
    expect(() => store.updateRun(record.id, { workflowDef: { ...workflow, description: 'changed after acceptance' } })).toThrow(/immutable/);
    manager.cancel(record.id);
  });

  it('fails closed when recovery finds a stale pinned workflow definition', async () => {
    reboot({ maxParallel: 0 });
    const workflow: WorkflowDef = { name: 'pinned-recovery', source: 'built-in', steps: [{ id: 'task', prompt: 'do it' }] };
    const record = manager.startRun(workflow, { task: 'recover pinned run', worktree: false });
    store.flush();
    manager.dispose();
    const runsPath = join(repoRoot, '.ai/cezar', 'runs.json');
    const records = JSON.parse(readFileSync(runsPath, 'utf8')) as Array<RunRecord & { workflowDef?: WorkflowDef }>;
    const persisted = records.find((candidate) => candidate.id === record.id)!;
    persisted.workflowDef = { ...workflow, description: 'stale replacement' };
    persisted.status = 'queued';
    persisted.steps = persisted.steps.map((step) => ({ ...step, status: 'pending', sessionId: undefined }));
    writeFileSync(runsPath, JSON.stringify(records, null, 2));
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    manager = boot({ maxParallel: 0 });
    await manager.recover();
    expect(store.getRun(record.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('pin') });
  });

  it('fails closed when recovery finds a policy pin that no longer matches the run', async () => {
    reboot({ maxParallel: 0 });
    const workflow: WorkflowDef = { name: 'policy-pinned', source: 'built-in', steps: [{ id: 'task', prompt: 'do it' }] };
    const record = manager.startRun(workflow, { task: 'recover policy-pinned run', worktree: false });
    store.flush();
    manager.dispose();
    const runsPath = join(repoRoot, '.ai/cezar', 'runs.json');
    const records = JSON.parse(readFileSync(runsPath, 'utf8')) as Array<RunRecord & { workflowDefinitionPin?: NonNullable<RunRecord['workflowDefinitionPin']> }>;
    const persisted = records.find((candidate) => candidate.id === record.id)!;
    persisted.status = 'queued';
    persisted.steps = persisted.steps.map((step) => ({ ...step, status: 'pending', sessionId: undefined }));
    persisted.workflowDefinitionPin!.policyPins = [{ id: 'factory-release-manifest', version: '0'.repeat(40), digest: '0'.repeat(64) }];
    writeFileSync(runsPath, JSON.stringify(records, null, 2));
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    manager = boot({ maxParallel: 0 });
    await manager.recover();
    expect(store.getRun(record.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('policy pin') });
  });

  afterEach(async () => {
    for (const id of started) manager.cancel(id);
    // Cancellation interrupts the agent process, but the terminal lifecycle and its final
    // writes happen asynchronously. Do not remove the repository while a dispatched child is
    // still finishing inside it — under a full-suite load that races the recursive delete and
    // surfaces as ENOTEMPTY (#986).
    const deadline = Date.now() + 10_000;
    while (store.listRuns().some(({ id }) => manager.isActive(id))) {
      if (Date.now() >= deadline) throw new Error('timed out waiting for dispatch runs to stop');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    manager.dispose();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    try {
      rmSync(repoRoot, { recursive: true, force: true, maxRetries: 25, retryDelay: 100 });
    } catch (error) {
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EBUSY') throw error;
      console.warn(`[dispatch-engine.test] Windows kept a locked temporary directory for runner cleanup: ${repoRoot}`);
    }
  });

  /** A manager with its own semaphore, so a test can decide how much of the tree may run. */
  const boot = (limits: Partial<WorkspaceResourceLimits> = {}): RunManager =>
    new RunManager(store, repoRoot, { semaphore: new WorkspaceSemaphore({ initial: limits }) });

  /** Re-boot the manager with different limits (before anything has started). */
  const reboot = (limits: Partial<WorkspaceResourceLimits>): void => {
    manager.dispose();
    manager = boot(limits);
  };

  const start = (task: string, dispatch?: RunDispatch, extra: Record<string, unknown> = {}): RunRecord => {
    const record = manager.startRun(SINGLE_STEP, { task, ...(dispatch ? { dispatch } : {}), ...extra });
    started.push(record.id);
    return record;
  };

  const waitFor = async (id: string, pred: (r: RunRecord | undefined) => boolean, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!pred(store.getRun(id))) {
      if (Date.now() > deadline) throw new Error(`condition not met in time for ${id}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const notes = (id: string): string[] =>
    store
      .readEvents(id)
      .filter((event) => event.type === 'note')
      .map((event) => String((event as { message?: unknown }).message ?? ''));

  const childrenOf = (parentId: string): RunRecord[] =>
    store.listRuns().filter((r) => r.dispatch?.parentRunId === parentId);

  const settled = (r: RunRecord | undefined): boolean =>
    r !== undefined && ['done', 'review', 'failed', 'cancelled'].includes(r.status);

  /** Everything the mock has been handed on stdin so far — '' before its first session opens. */
  const stdin = (file: string): string => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  };

  /** The full inbound message containing `needle` (the scripted replies only echo a slice). */
  const delivered = (file: string, needle: string): string | undefined =>
    stdin(file)
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { userText: string })
      .find((entry) => entry.userText.includes(needle))?.userText;

  const activeState = (id: string) =>
    (manager as unknown as {
      active: Map<string, { monitoringWakeTimer?: NodeJS.Timeout }>;
    }).active.get(id);

  /** A root's dispatch record — it names itself. */
  const rootOf = (id: string, budgetUsd?: number): RunDispatch => ({
    rootRunId: id,
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
  });
  const childOf = (rootId: string, parentId = rootId): RunDispatch => ({ rootRunId: rootId, parentRunId: parentId });
  const treeDirOf = (rootId: string) => join(repoRoot, '.ai/cezar/dispatch', rootId);
  const order = (objective: string, extra: Partial<DispatchInput> = {}): DispatchInput => ({ objective, ...extra });
  /** Start a root that parks as a monitor, so dispatches against it are observable. */
  const parkedRoot = async (budgetUsd?: number): Promise<RunRecord> => {
    const record = start('mock:monitoring waiting on my tasks');
    store.updateRun(record.id, { dispatch: rootOf(record.id, budgetUsd) });
    await waitFor(record.id, (r) => r?.activity === 'monitoring');
    return record;
  };
  const dispatchOk = (parentId: string, input: DispatchInput): { id: string; branch?: string } => {
    const outcome = manager.dispatch(parentId, input);
    if ('refused' in outcome) throw new Error(`dispatch refused: ${outcome.refused}`);
    return outcome;
  };
  const refusal = (parentId: string, input: DispatchInput): string => {
    const outcome = manager.dispatch(parentId, input);
    if (!('refused' in outcome)) throw new Error('expected a refusal');
    return outcome.refused;
  };

  // ---- dispatch ------------------------------------------------------------------------------

  describe('dispatch()', () => {
    it('runs a versioned agent graph through the existing run and dispatch records', async () => {
      const workflow = versionedWorkflowSchema.parse({
        contract: 'cezar.workflow', schemaVersion: 1, id: 'runtime-smoke', version: '1.0.0',
        entry: 'implement', terminals: ['implement'], inputs: [], policyRefs: [], budget: {}, capabilities: [],
        compatibility: { mode: 'versioned-only', minConsumer: '0.14.0', maxConsumer: '0.14.0' },
        nodes: [{ id: 'implement', kind: 'agent', dispatchKind: 'implement', session: 'continue', prompt: 'mock:pause mock:done {{task}}', outcomes: ['passed'] }],
        transitions: [],
      });
      const root = manager.startVersionedRun(workflow, { task: 'finish the versioned graph', dispatchIntent: { budgetUsd: 2 } }, {});
      expect(store.getRun(root.id)?.workflowDefinitionPin).toMatchObject({ format: 'versioned', id: 'runtime-smoke', version: '1.0.0' });
      expect(store.getRun(root.id)?.dispatch?.intent).toEqual({ budgetUsd: 2 });
      await waitFor(root.id, (record) => childrenOf(root.id).length === 1);
      const child = childrenOf(root.id)[0]!;
      started.push(child.id);
      await waitFor(child.id, (record) => record?.status === 'running' && record.steps.some((step) => Boolean(step.sessionId)));
      expect(manager.recordReport(child.id, {
        status: 'done', outcome: 'passed', result: 'Graph node completed.', evidence: [], side_effects: [], errors: [], suggestions: [],
      })).toBe(true);
      await waitFor(root.id, (record) => record?.status === 'done', 40_000);
      expect(store.getRun(root.id)?.workflowExecution).toMatchObject({ status: 'done', outcomes: { implement: 'passed' } });
      expect(store.readEvents(root.id).some((event) => String(event.message).includes('node "implement" returned passed'))).toBe(true);
    }, 60_000);

    it('charges durable child token usage once and prevents an over-budget PASS', async () => {
      const workflow = versionedWorkflowSchema.parse({
        contract: 'cezar.workflow', schemaVersion: 1, id: 'runtime-token-budget', version: '1.0.0',
        entry: 'work', terminals: ['work'], inputs: [], policyRefs: [], budget: { maxTokens: 5 }, capabilities: [],
        compatibility: { mode: 'versioned-only', minConsumer: '0.14.0', maxConsumer: '0.14.0' },
        nodes: [{ id: 'work', kind: 'agent', prompt: 'mock:pause mock:done count tokens', outcomes: ['passed'] }],
        transitions: [],
      });
      const root = manager.startVersionedRun(workflow, { task: 'enforce token usage', runner: 'claude' }, {});
      await waitFor(root.id, () => childrenOf(root.id).length === 1);
      const child = childrenOf(root.id)[0]!;
      started.push(child.id);
      await waitFor(child.id, (record) => record?.status === 'running' && record.steps.some((step) => Boolean(step.sessionId)));
      store.updateRun(child.id, { inputTokens: 4, outputTokens: 3 });
      expect(manager.recordReport(child.id, { status: 'done', outcome: 'passed', result: 'Finished.', evidence: [], side_effects: [], errors: [], suggestions: [] })).toBe(true);
      await waitFor(root.id, (record) => record?.status === 'failed', 40_000);
      expect(store.getRun(root.id)?.error).toMatch(/exceeded its 5-token budget/);
    }, 60_000);

    it('reconciles a persisted external action receipt after a crash without repeating the action', async () => {
      const workflow = versionedWorkflowSchema.parse({
        contract: 'cezar.workflow', schemaVersion: 1, id: 'runtime-action-recovery', version: '1.0.0',
        entry: 'label', terminals: ['label'], inputs: [], policyRefs: [], budget: {}, capabilities: ['github.issue.write'],
        compatibility: { mode: 'versioned-only', minConsumer: '0.14.0', maxConsumer: '0.14.0' },
        nodes: [{ id: 'label', kind: 'action', action: 'github.issue.label', capabilities: ['github.issue.write'], outcomes: ['passed'] }],
        transitions: [],
      });
      let externalEffectApplied = false;
      let executeCount = 0;
      const actionKeys: string[] = [];
      const result = {
        outcome: 'passed' as const, outputs: { label: 'factory:working' },
        receipt: { system: 'github', resource: 'issue:765', operation: 'add-label', receiptId: 'delivery:765:working' },
      };
      const actionAdapter = {
        execute: async (request: { idempotencyKey: string }) => {
          actionKeys.push(request.idempotencyKey);
          executeCount += 1;
          externalEffectApplied = true;
          return new Promise<typeof result>(() => {}); // simulate process loss after the remote effect but before local receipt persistence
        },
        reconcile: async (request: { idempotencyKey: string }) => {
          actionKeys.push(request.idempotencyKey);
          return externalEffectApplied ? { status: 'applied' as const, result } : { status: 'not_applied' as const };
        },
      };
      manager.registerVersionedWorkflowAction('github.issue.label', actionAdapter);
      const root = manager.startVersionedRun(workflow, { task: 'label issue 765', runner: 'claude' }, {});
      started.push(root.id);
      await waitFor(root.id, () => externalEffectApplied);
      expect(store.getRun(root.id)?.workflowExecution?.attempts[0]?.effectReceipt).toMatchObject({ status: 'pending', action: 'github.issue.label' });
      manager.dispose();
      await manager.recover();
      await waitFor(root.id, (record) => record?.status === 'done', 5_000);
      expect(executeCount).toBe(1);
      expect(new Set(actionKeys).size).toBe(1);
      expect(store.getRun(root.id)?.workflowExecution?.attempts[0]?.effectReceipt).toMatchObject({
        status: 'confirmed', action: 'github.issue.label', outcome: 'passed', receipt: { receiptId: 'delivery:765:working' },
      });
    }, 30_000);

    it('keeps an external action non-passing when reconciliation is unknown', async () => {
      const workflow = versionedWorkflowSchema.parse({
        contract: 'cezar.workflow', schemaVersion: 1, id: 'runtime-action-unknown', version: '1.0.0',
        entry: 'label', terminals: ['label'], inputs: [], policyRefs: [], budget: {}, capabilities: ['github.issue.write'],
        compatibility: { mode: 'versioned-only', minConsumer: '0.14.0', maxConsumer: '0.14.0' },
        nodes: [{ id: 'label', kind: 'action', action: 'github.issue.label', capabilities: ['github.issue.write'], outcomes: ['passed'] }],
        transitions: [],
      });
      const execute = vi.fn(async () => ({ outcome: 'passed' as const, receipt: { system: 'github', resource: 'issue:765', operation: 'add-label', receiptId: 'unexpected' } }));
      manager.registerVersionedWorkflowAction('github.issue.label', { execute, reconcile: async () => ({ status: 'unknown' as const, reason: 'remote unavailable' }) });
      const root = manager.startVersionedRun(workflow, { task: 'require action reconciliation', runner: 'claude' }, {});
      started.push(root.id);
      await waitFor(root.id, (record) => record?.status === 'failed', 5_000);
      expect(execute).not.toHaveBeenCalled();
      expect(store.getRun(root.id)?.workflowExecution).toMatchObject({ status: 'failed', attempts: [{ effectReceipt: { status: 'unknown' } }] });
    }, 30_000);

    it('recovers a queued versioned child by replaying its stable transition instead of duplicating it', async () => {
      const workflow = versionedWorkflowSchema.parse({
        contract: 'cezar.workflow', schemaVersion: 1, id: 'runtime-recovery', version: '1.0.0',
        entry: 'work', terminals: ['work'], inputs: [], policyRefs: [], budget: {}, capabilities: [],
        compatibility: { mode: 'versioned-only', minConsumer: '0.14.0', maxConsumer: '0.14.0' },
        nodes: [{ id: 'work', kind: 'agent', dispatchKind: 'implement', session: 'continue', prompt: 'mock:pause mock:done recover this graph', outcomes: ['passed'] }],
        transitions: [],
      });
      reboot({ maxParallel: 0 });
      const root = manager.startVersionedRun(workflow, { task: 'recover the same logical run' }, {});
      await waitFor(root.id, (record) => childrenOf(root.id).length === 1 && childrenOf(root.id)[0]?.status === 'queued');
      const childId = childrenOf(root.id)[0]!.id;
      manager.dispose();
      manager = boot();
      await manager.recover();
      await waitFor(childId, (record) => record?.status === 'running' && record.steps.some((step) => Boolean(step.sessionId)), 40_000);
      expect(childrenOf(root.id).map((child) => child.id)).toEqual([childId]);
      expect(manager.recordReport(childId, { status: 'done', outcome: 'passed', result: 'Recovered child passed.', evidence: [], side_effects: [], errors: [], suggestions: [] })).toBe(true);
      await waitFor(root.id, (record) => record?.status === 'done', 40_000);
      expect(childrenOf(root.id)).toHaveLength(1);
    }, 90_000);

    it('marks the durable graph failed when recovery detects a stale exact version pin', async () => {
      const workflow = versionedWorkflowSchema.parse({
        contract: 'cezar.workflow', schemaVersion: 1, id: 'runtime-stale-pin', version: '1.0.0',
        entry: 'work', terminals: ['work'], inputs: [], policyRefs: [], budget: {}, capabilities: [],
        compatibility: { mode: 'versioned-only', minConsumer: '0.14.0', maxConsumer: '0.14.0' },
        nodes: [{ id: 'work', kind: 'agent', prompt: 'mock:pause mock:done stale pin', outcomes: ['passed'] }],
        transitions: [],
      });
      reboot({ maxParallel: 0 });
      const root = manager.startVersionedRun(workflow, { task: 'reject stale workflow content', runner: 'claude' }, {});
      store.flush();
      manager.dispose();
      const records = JSON.parse(readFileSync(join(repoRoot, '.ai/cezar', 'runs.json'), 'utf8')) as Array<RunRecord>;
      const persisted = records.find((candidate) => candidate.id === root.id)!;
      persisted.workflowDefinitionPin!.digest = '0'.repeat(64);
      writeFileSync(join(repoRoot, '.ai/cezar', 'runs.json'), JSON.stringify(records, null, 2));
      store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
      manager = boot({ maxParallel: 0 });
      await manager.recover();
      started.push(root.id, ...childrenOf(root.id).map((child) => child.id));
      expect(store.getRun(root.id)).toMatchObject({ status: 'failed', workflowExecution: { status: 'failed' }, error: expect.stringContaining('pin') });
    }, 30_000);

    it('does not report a terminal PASS when an agent omits or returns an unknown outcome', async () => {
      const workflow = versionedWorkflowSchema.parse({
        contract: 'cezar.workflow', schemaVersion: 1, id: 'runtime-unknown', version: '1.0.0',
        entry: 'work', terminals: ['work'], inputs: [], policyRefs: [], budget: {}, capabilities: [],
        compatibility: { mode: 'versioned-only', minConsumer: '0.14.0', maxConsumer: '0.14.0' },
        nodes: [{ id: 'work', kind: 'agent', dispatchKind: 'implement', session: 'continue', prompt: 'mock:pause mock:done return unknown', outcomes: ['passed', 'unknown'] }],
        transitions: [],
      });
      const root = manager.startVersionedRun(workflow, { task: 'unknown must not pass' }, {});
      await waitFor(root.id, () => childrenOf(root.id).length === 1);
      const child = childrenOf(root.id)[0]!;
      started.push(child.id);
      await waitFor(child.id, (record) => record?.status === 'running' && record.steps.some((step) => Boolean(step.sessionId)));
      expect(manager.recordReport(child.id, { status: 'done', result: 'No trustworthy result.', evidence: [], side_effects: [], errors: [], suggestions: [] })).toBe(true);
      await waitFor(root.id, (record) => record?.status === 'failed', 40_000);
      expect(store.getRun(root.id)?.workflowExecution).toMatchObject({ status: 'failed', outcomes: { work: 'unknown' } });
    }, 60_000);

    it('times out a persisted human wait and rejects a late resume', async () => {
      const workflow = versionedWorkflowSchema.parse({
        contract: 'cezar.workflow', schemaVersion: 1, id: 'runtime-wait-timeout', version: '1.0.0',
        entry: 'approval', terminals: ['approval'], inputs: [], policyRefs: [], budget: {}, capabilities: [],
        compatibility: { mode: 'versioned-only', minConsumer: '0.14.0', maxConsumer: '0.14.0' },
        nodes: [{ id: 'approval', kind: 'wait', reason: 'approval required', waitFor: 'human', timeoutSeconds: 1, outcomes: ['passed'] }],
        transitions: [],
      });
      const root = manager.startVersionedRun(workflow, { task: 'wait for approval' }, {});
      expect(store.getRun(root.id)).toMatchObject({ status: 'waiting', workflowExecution: { status: 'waiting', wait: { reason: 'human' } } });
      await waitFor(root.id, (record) => record?.status === 'failed', 5_000);
      expect(store.getRun(root.id)?.workflowExecution?.status).toBe('failed');
      expect(manager.resumeVersionedRun(root.id, { kind: 'human' }).ok).toBe(false);
    }, 10_000);

    it('enforces the persisted workflow-wide duration budget across a human wait', async () => {
      const workflow = versionedWorkflowSchema.parse({
        contract: 'cezar.workflow', schemaVersion: 1, id: 'runtime-duration-budget', version: '1.0.0',
        entry: 'approval', terminals: ['approval'], inputs: [], policyRefs: [], budget: { maxDurationSeconds: 1 }, capabilities: [],
        compatibility: { mode: 'versioned-only', minConsumer: '0.14.0', maxConsumer: '0.14.0' },
        nodes: [{ id: 'approval', kind: 'wait', reason: 'approval required', waitFor: 'human', outcomes: ['passed'] }],
        transitions: [],
      });
      const root = manager.startVersionedRun(workflow, { task: 'respect the graph deadline' }, {});
      expect(store.getRun(root.id)?.status).toBe('waiting');
      manager.dispose();
      manager = boot({ maxParallel: 0 });
      await manager.recover();
      await waitFor(root.id, (record) => record?.status === 'failed', 5_000);
      expect(store.getRun(root.id)?.error).toMatch(/duration budget/);
      expect(manager.resumeVersionedRun(root.id, { kind: 'human' }).ok).toBe(false);
    }, 10_000);

    it('recovers an event wait durably and resumes it only when the named event arrives', async () => {
      const workflow = versionedWorkflowSchema.parse({
        contract: 'cezar.workflow', schemaVersion: 1, id: 'runtime-event-wait', version: '1.0.0',
        entry: 'event-gate', terminals: ['event-gate'], inputs: [], policyRefs: [], budget: {}, capabilities: [],
        compatibility: { mode: 'versioned-only', minConsumer: '0.14.0', maxConsumer: '0.14.0' },
        nodes: [{ id: 'event-gate', kind: 'wait', reason: 'GitHub event', waitFor: 'event', event: 'issue.approved', outcomes: ['passed'] }],
        transitions: [],
      });
      const root = manager.startVersionedRun(workflow, { task: 'wait for the issue event' }, {});
      expect(store.getRun(root.id)?.status).toBe('waiting');
      manager.dispose();
      manager = boot();
      await manager.recover();
      expect(store.getRun(root.id)?.workflowExecution?.wait).toMatchObject({ reason: 'event', event: 'issue.approved' });
      expect(manager.resumeVersionedRun(root.id, { kind: 'event', event: 'issue.closed' }).ok).toBe(false);
      const eventTrigger = { kind: 'event' as const, event: 'issue.approved', eventId: 'hook-delivery-1' };
      expect(manager.resumeVersionedRun(root.id, eventTrigger).ok).toBe(true);
      const afterFirstDelivery = store.getRun(root.id);
      expect(manager.resumeVersionedRun(root.id, eventTrigger)).toEqual({ ok: true });
      expect(store.getRun(root.id)).toEqual(afterFirstDelivery);
      expect(store.getRun(root.id)).toMatchObject({ status: 'done', workflowExecution: { status: 'done', outcomes: { 'event-gate': 'passed' } } });
      expect(store.getRun(root.id)?.workflowExecution?.eventReceipts).toMatchObject([{ eventId: 'hook-delivery-1', event: 'issue.approved', node: 'event-gate' }]);
    }, 30_000);

    it('persists graph cancellation before cancelling its forked child runs', async () => {
      const workflow = versionedWorkflowSchema.parse({
        contract: 'cezar.workflow', schemaVersion: 1, id: 'runtime-cancel', version: '1.0.0',
        entry: 'parallel', terminals: ['parallel', 'alpha', 'beta'], inputs: [], policyRefs: [], budget: {}, capabilities: [],
        compatibility: { mode: 'versioned-only', minConsumer: '0.14.0', maxConsumer: '0.14.0' },
        nodes: [
          { id: 'parallel', kind: 'fork', children: ['alpha', 'beta'], join: { mode: 'all' }, outcomes: ['passed', 'unknown'] },
          { id: 'alpha', kind: 'agent', dispatchKind: 'implement', session: 'new', prompt: 'mock:pause mock:done cancel branch one', outcomes: ['passed'] },
          { id: 'beta', kind: 'agent', dispatchKind: 'implement', session: 'new', prompt: 'mock:pause mock:done cancel branch two', outcomes: ['passed'] },
        ],
        transitions: [],
      });
      const root = manager.startVersionedRun(workflow, { task: 'cancel the graph' }, {});
      await waitFor(root.id, () => childrenOf(root.id).length === 2);
      started.push(...childrenOf(root.id).map((child) => child.id));
      expect(manager.cancel(root.id)).toBe(true);
      await waitFor(root.id, (record) => record?.status === 'cancelled');
      await waitFor(root.id, () => childrenOf(root.id).every((child) => child.status === 'cancelled'), 30_000);
      expect(store.getRun(root.id)?.workflowExecution?.status).toBe('cancelled');
    }, 60_000);

    it('runs a sealed versioned all-join and requires typed passing reports from every branch', async () => {
      const workflow = versionedWorkflowSchema.parse({
        contract: 'cezar.workflow', schemaVersion: 1, id: 'runtime-fork', version: '1.0.0',
        entry: 'parallel', terminals: ['parallel', 'alpha', 'beta'], inputs: [], policyRefs: [], budget: {}, capabilities: [],
        compatibility: { mode: 'versioned-only', minConsumer: '0.14.0', maxConsumer: '0.14.0' },
        nodes: [
          { id: 'parallel', kind: 'fork', children: ['alpha', 'beta'], join: { mode: 'all' }, outcomes: ['passed', 'unknown'] },
          { id: 'alpha', kind: 'agent', dispatchKind: 'implement', session: 'new', prompt: 'mock:pause mock:done first branch', outcomes: ['passed'] },
          { id: 'beta', kind: 'agent', dispatchKind: 'implement', session: 'new', prompt: 'mock:pause mock:done second branch', outcomes: ['passed'] },
        ],
        transitions: [],
      });
      const root = manager.startVersionedRun(workflow, { task: 'run the fork' }, {});
      await waitFor(root.id, (record) => childrenOf(root.id).length === 2);
      const children = childrenOf(root.id);
      started.push(...children.map((child) => child.id));
      for (const child of children) await waitFor(child.id, (record) => record?.status === 'running' && record.steps.some((step) => Boolean(step.sessionId)));
      for (const child of children) {
        expect(manager.recordReport(child.id, {
          status: 'done', outcome: 'passed', result: 'Branch completed.', evidence: [], side_effects: [], errors: [], suggestions: [],
        })).toBe(true);
      }
      await waitFor(root.id, (record) => record?.status === 'done', 40_000);
      expect(store.getRun(root.id)?.dispatch?.joins).toMatchObject([{ mode: 'all', outcome: 'passed', sealed: true, expectedChildren: 2 }]);
      expect(store.getRun(root.id)?.workflowExecution).toMatchObject({ status: 'done', outcomes: { alpha: 'passed', beta: 'passed', parallel: 'passed' } });
    }, 60_000);

    it('calls and returns from a nested versioned workflow through child-run linkage', async () => {
      const leaf = {
        contract: 'cezar.workflow', schemaVersion: 1, id: 'nested-leaf', version: '1.0.0',
        entry: 'leaf-work', terminals: ['leaf-work'], inputs: [], policyRefs: [], budget: {}, capabilities: [],
        compatibility: { mode: 'versioned-only', minConsumer: '0.14.0', maxConsumer: '0.14.0' },
        nodes: [{ id: 'leaf-work', kind: 'agent', dispatchKind: 'implement', session: 'continue', prompt: 'mock:pause mock:done leaf work', outcomes: ['passed'] }],
        transitions: [],
      };
      const workflowDir = join(repoRoot, '.ai/cezar/workflows');
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(join(workflowDir, 'nested-leaf.workflow.json'), JSON.stringify(leaf));
      const parentWorkflow = versionedWorkflowSchema.parse({
        contract: 'cezar.workflow', schemaVersion: 1, id: 'nested-parent', version: '1.0.0',
        entry: 'call-leaf', terminals: ['call-leaf'], inputs: [], policyRefs: [], budget: {}, capabilities: [],
        compatibility: { mode: 'versioned-only', minConsumer: '0.14.0', maxConsumer: '0.14.0' },
        nodes: [{ id: 'call-leaf', kind: 'child_workflow', workflow: 'nested-leaf', version: '1.0.0', outcomes: ['passed', 'unknown'] }],
        transitions: [],
      });
      const root = manager.startVersionedRun(parentWorkflow, { task: 'call the child graph' }, {});
      await waitFor(root.id, (record) => childrenOf(root.id).length === 1);
      const nested = childrenOf(root.id)[0]!;
      await waitFor(nested.id, (record) => childrenOf(nested.id).length === 1);
      const leafWorker = childrenOf(nested.id)[0]!;
      started.push(nested.id, leafWorker.id);
      await waitFor(leafWorker.id, (record) => record?.status === 'running' && record.steps.some((step) => Boolean(step.sessionId)));
      expect(manager.recordReport(leafWorker.id, {
        status: 'done', outcome: 'passed', result: 'Nested leaf passed.', evidence: [], side_effects: [], errors: [], suggestions: [],
      })).toBe(true);
      await waitFor(root.id, (record) => record?.status === 'done', 40_000);
      expect(store.getRun(nested.id)?.workflowExecution?.status).toBe('done');
      expect(store.getRun(root.id)?.workflowExecution).toMatchObject({ status: 'done', outcomes: { 'call-leaf': 'passed' } });
    }, 60_000);

    it('keeps one implementation session through repair and gives both reviews distinct sessions', async () => {
      const workflow = versionedWorkflowSchema.parse({
        contract: 'cezar.workflow', schemaVersion: 1, id: 'implement-review-repair', version: '1.0.0',
        entry: 'implement', terminals: ['review-again'], inputs: [], policyRefs: [], budget: {}, capabilities: [],
        compatibility: { mode: 'versioned-only', minConsumer: '0.14.0', maxConsumer: '0.14.0' },
        nodes: [
          { id: 'implement', kind: 'agent', dispatchKind: 'implement', session: 'continue', prompt: 'mock:pause mock:done implement {{task}}', outcomes: ['passed', 'changes_required'] },
          { id: 'review', kind: 'agent', dispatchKind: 'review', session: 'new', prompt: 'mock:pause mock:done review implementation', outcomes: ['passed', 'changes_required'] },
          { id: 'repair', kind: 'agent', dispatchKind: 'implement', session: 'continue', prompt: 'mock:pause mock:done repair the finding', outcomes: ['passed'] },
          { id: 'review-again', kind: 'agent', dispatchKind: 'review', session: 'new', prompt: 'mock:pause mock:done review the repair', outcomes: ['passed'] },
        ],
        transitions: [
          { from: 'implement', outcome: 'passed', to: 'review', order: 0 },
          { from: 'implement', outcome: 'changes_required', to: 'review', order: 1 },
          { from: 'review', outcome: 'passed', to: 'review-again', order: 0 },
          { from: 'review', outcome: 'changes_required', to: 'repair', order: 1 },
          { from: 'repair', outcome: 'passed', to: 'review-again', order: 0 },
        ],
      });
      const root = manager.startVersionedRun(workflow, { task: 'implement with review gates', runner: 'claude' }, {});
      const findChild = async (count: number): Promise<RunRecord[]> => {
        await waitFor(root.id, () => childrenOf(root.id).length === count, 40_000);
        return childrenOf(root.id);
      };
      const settleNode = async (child: RunRecord, outcome: 'passed' | 'changes_required', result: string) => {
        await waitFor(child.id, (record) => record?.status === 'running' && record.steps.some((step) => Boolean(step.sessionId)), 40_000);
        expect(manager.recordReport(child.id, { status: 'done', outcome, result, evidence: [], side_effects: [], errors: [], suggestions: [], verdict: outcome === 'passed' ? 'approve' : 'changes' })).toBe(true);
      };
      const firstSet = await findChild(1);
      const implementation = firstSet[0]!;
      started.push(implementation.id);
      await settleNode(implementation, 'changes_required', 'Implementation ready for review.');
      const implementationSession = store.getRun(implementation.id)?.steps.find((step) => step.sessionId)?.sessionId;

      const secondSet = await findChild(2);
      const firstReview = secondSet.find((child) => child.id !== implementation.id)!;
      started.push(firstReview.id);
      expect(store.getRun(firstReview.id)?.workflowDef?.steps[0]?.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
      await settleNode(firstReview, 'changes_required', 'One repair is needed.');

      await waitFor(implementation.id, (record) => record?.status === 'running' && record.steps.some((step) => step.id.startsWith('continue-') && step.sessionId), 40_000);
      const repairSession = store.getRun(implementation.id)?.steps.find((step) => step.id.startsWith('continue-') && step.sessionId)?.sessionId;
      expect(repairSession).toBe(implementationSession);
      expect(manager.recordReport(implementation.id, { status: 'done', outcome: 'passed', result: 'Repair complete.', evidence: [], side_effects: [], errors: [], suggestions: [] })).toBe(true);

      const thirdSet = await findChild(3);
      const secondReview = thirdSet.find((child) => child.id !== implementation.id && child.id !== firstReview.id)!;
      started.push(secondReview.id);
      expect(store.getRun(secondReview.id)?.workflowDef?.steps[0]?.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
      await settleNode(secondReview, 'passed', 'Repair verified.');
      await waitFor(root.id, (record) => record?.status === 'done', 40_000);

      const firstReviewSession = store.getRun(firstReview.id)?.steps.find((step) => step.sessionId)?.sessionId;
      const secondReviewSession = store.getRun(secondReview.id)?.steps.find((step) => step.sessionId)?.sessionId;
      expect(firstReviewSession).toBeTruthy();
      expect(secondReviewSession).toBeTruthy();
      expect(new Set([implementationSession, firstReviewSession, secondReviewSession]).size).toBe(3);
      expect(store.getRun(root.id)?.workflowExecution).toMatchObject({ status: 'done', outcomes: { implement: 'changes_required', review: 'changes_required', repair: 'passed', 'review-again': 'passed' } });
    }, 120_000);

    it('replays one stable transition to the same child and rejects key reuse with different work', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const parent = await parkedRoot(20);
      const transition = order('mock:done deterministic child', { transition_id: 'workflow/repair/attempt-1', max_cost: 2.5 });
      const created = dispatchOk(parent.id, transition);
      const replay = dispatchOk(parent.id, { ...transition, objective: 'mock:done deterministic child' });
      expect(replay.id).toBe(created.id);
      expect(childrenOf(parent.id)).toHaveLength(1);
      expect(store.getRun(created.id)?.dispatch).toMatchObject({
        parentRunId: parent.id,
        transitionId: 'workflow/repair/attempt-1',
        transitionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(refusal(parent.id, order('different child', { transition_id: 'workflow/repair/attempt-1', max_cost: 2.5 }))).toContain('different work');
      expect(childrenOf(parent.id)).toHaveLength(1);
      store.flush();
      const persisted = (JSON.parse(readFileSync(join(repoRoot, '.ai/cezar', 'runs.json'), 'utf8')) as RunRecord[])
        .find((run) => run.id === created.id);
      expect(runRecordSchema.parse(persisted)?.dispatch).toMatchObject({
        transitionId: 'workflow/repair/attempt-1',
        transitionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    }, 40_000);

    it('replays the same child after RunStore restart without reserving budget twice', () => {
      reboot({ maxParallel: 0 });
      const parent = store.createRun({ title: 'root', workflow: 'fixture', task: 'task', steps: [], dispatch: { rootRunId: 'pending' } });
      store.updateRun(parent.id, { status: 'waiting', dispatch: rootOf(parent.id, 10) });
      const input = order('durable child', { transition_id: 'workflow/child/1', max_cost: 4 });
      const first = dispatchOk(parent.id, input);
      store.flush();
      manager.dispose();
      store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
      manager = boot({ maxParallel: 0 });
      const replay = dispatchOk(parent.id, input);
      expect(replay.id).toBe(first.id);
      expect(childrenOf(parent.id)).toHaveLength(1);
      expect(store.getRun(first.id)?.dispatch?.budgetUsd).toBe(4);
    });

    it('gives a review child its own run and review-only context', () => {
      reboot({ maxParallel: 0 });
      const parent = store.createRun({ title: 'implementer', workflow: 'fixture', task: 'implement', steps: [] });
      store.updateRun(parent.id, { status: 'waiting', dispatch: rootOf(parent.id) });
      const child = dispatchOk(parent.id, order('review the candidate', { kind: 'review', review_of: ['candidate-branch'] }));
      started.push(child.id);
      const queued = (manager as unknown as { pendingJobs: Map<string, { input: { systemPrompt?: string } }> }).pendingJobs.get(child.id);
      expect(store.getRun(child.id)?.dispatch).toMatchObject({ parentRunId: parent.id, kind: 'review' });
      expect(child.id).not.toBe(parent.id);
      expect(queued?.input.systemPrompt).toContain('Your KIND is review');
      expect(queued?.input.systemPrompt).toContain('You edit nothing on the reviewed branch');
    });

    it('creates a child forked off the parent branch, with its order, budget and tree files', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const parent = await parkedRoot(20);
      const created = dispatchOk(parent.id, order('mock:done take the left flank', {
        title: 'Take the left flank',
        scope: 'src/left/**',
        max_cost: 2.5,
        success_criteria: 'the left half compiles and its tests pass',
        retry_limit: 1,
      }));
      const child = store.getRun(created.id);
      expect(child?.title).toBe('Take the left flank');
      expect(child?.dispatch).toEqual({ rootRunId: parent.id, parentRunId: parent.id, budgetUsd: 2.5 });
      expect(child?.autonomous).toBe(true);
      // The child forks off the PARENT's branch, which is what `execute()` reads.
      expect(child?.baseBranch).toBe(store.getRun(parent.id)?.branch);
      expect(child?.baseBranch).toMatch(/^cez\//);
      // The task order the child receives — its own scope, the fork point, its files.
      expect(child?.task).toContain('## Task order');
      expect(child?.task).toContain('- Scope: src/left/**');
      expect(child?.task).toContain('- Max cost: $2.50');
      expect(child?.task).toContain(`- Ordered by: run ${parent.id}`);
      expect(child?.task).toContain('brief.md');
      expect(child?.task).not.toContain('{{TREE_PATHS}}');
      const dir = join(treeDirOf(parent.id), 'units', created.id.slice(0, 8));
      expect(readFileSync(join(dir, 'order.md'), 'utf8')).toContain('Take the left flank');
      expect(readFileSync(join(dir, 'notes.md'), 'utf8')).toContain('## Suggestions for the root');
      expect(readFileSync(join(treeDirOf(parent.id), 'brief.md'), 'utf8')).toContain('waiting on my tasks');
      expect(readFileSync(join(treeDirOf(parent.id), 'ledger.jsonl'), 'utf8')).toContain('"type":"dispatch"');
      // The parent's transcript says who it dispatched.
      expect(notes(parent.id).some((n) => n.startsWith('dispatched "Take the left flank"'))).toBe(true);
    }, 40_000);

    it('makes a plain task a root on its first dispatch — no record needed up front', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const parent = start('mock:monitoring plain task');
      await waitFor(parent.id, (r) => r?.activity === 'monitoring');
      expect(store.getRun(parent.id)?.dispatch).toBeUndefined();
      const created = dispatchOk(parent.id, order('mock:done a piece'));
      expect(store.getRun(parent.id)?.dispatch).toEqual({ rootRunId: parent.id });
      expect(store.getRun(created.id)?.dispatch?.rootRunId).toBe(parent.id);
    }, 40_000);

    it('parks the dispatching task as a monitor when its turn ends, surrendering its slot', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const stdinFile = join(repoRoot, 'mock-stdin-dispatch.ndjson');
      savedEnv.CEZ_MOCK_STDIN_FILE = process.env.CEZ_MOCK_STDIN_FILE;
      process.env.CEZ_MOCK_STDIN_FILE = stdinFile;
      // A two-second turn: long enough to dispatch from "inside" it.
      const parent = start('mock:pause plan the work', undefined, { autonomous: true });
      await waitFor(parent.id, () => stdin(stdinFile).includes('plan the work'));
      dispatchOk(parent.id, order('mock:done a piece'));
      // The turn ends plainly; the dispatch makes it a monitoring park, not a nudge.
      await waitFor(parent.id, (r) => r?.activity === 'monitoring');
      expect(store.getRun(parent.id)?.status).toBe('running');
      expect(activeState(parent.id)?.monitoringWakeTimer).toBeDefined();
    }, 40_000);

    it('refuses a fifth child in flight, with the reason', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const parent = await parkedRoot(20);
      for (let i = 0; i < 4; i += 1) {
        const child = store.createRun({ title: `in flight ${i}`, workflow: '(planned)', task: 't', steps: [] });
        store.updateRun(child.id, { status: 'running', dispatch: childOf(parent.id) });
      }
      const reason = refusal(parent.id, order('one more'));
      expect(reason).toContain('the cap is 4');
      expect(childrenOf(parent.id)).toHaveLength(4);
      expect(notes(parent.id).some((n) => n.includes('dispatch refused') && n.includes('the cap is 4'))).toBe(true);
    }, 40_000);

    it('refuses a child that would overspend the parent, and hands an uncapped child the remainder', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const parent = await parkedRoot(1);
      expect(refusal(parent.id, order('too rich', { max_cost: 2.5 }))).toMatch(/only \$[\d.]+ of the budget is left/);
      const created = dispatchOk(parent.id, order('mock:done fits'));
      // The uncapped child gets the whole remainder — one child at a time, nobody to share with.
      const remainder = store.getRun(created.id)?.dispatch?.budgetUsd ?? 0;
      expect(remainder).toBeGreaterThan(0.5);
      expect(remainder).toBeLessThanOrEqual(1);
      expect(refusal(parent.id, order('nothing left'))).toContain('no budget left');
    }, 40_000);

    it('releases a settled child’s unspent budget to the parent', async () => {
      // Default slots: the parked parent and its child must both be able to run.
      const parent = await parkedRoot(5);
      const first = dispatchOk(parent.id, order('mock:done quick', { max_cost: 4 }));
      expect(refusal(parent.id, order('second', { max_cost: 3 }))).toMatch(/only \$[\d.]+ of the budget is left/);
      await waitFor(first.id, settled);
      // The first child settled far under its cap (a dry run costs cents at most), so its
      // reservation flows back and a second child of the same size fits.
      const second = dispatchOk(parent.id, order('mock:done second', { max_cost: 3 }));
      expect(store.getRun(second.id)?.dispatch?.budgetUsd).toBe(3);
    }, 60_000);

    it('honours the user’s intent: a lower in-flight cap, a total cap, and child defaults', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const parent = await parkedRoot(20);
      store.updateRun(parent.id, {
        dispatch: { ...rootOf(parent.id, 20), intent: { maxSubtasks: 3, inFlight: 2, runner: 'codex', model: 'gpt-5', budgetUsd: 1.5 } },
      });
      // Two children in flight fill the USER's cap of 2, well under the engine's 4.
      for (let i = 0; i < 2; i += 1) {
        const child = store.createRun({ title: `in flight ${i}`, workflow: '(planned)', task: 't', steps: [] });
        store.updateRun(child.id, { status: 'running', dispatch: childOf(parent.id) });
      }
      expect(refusal(parent.id, order('a third at once'))).toContain('the cap is 2 per task (set by the user)');
      // With one settled, a third child fits in flight but is the tree's third and last.
      const [first] = childrenOf(parent.id);
      store.updateRun(first!.id, { status: 'done' });
      const third = dispatchOk(parent.id, order('the last one'));
      const record = store.getRun(third.id);
      // Defaults from the intent fill what the order left out.
      expect(record?.runner).toBe('codex');
      expect(record?.model).toBe('gpt-5');
      expect(record?.dispatch?.budgetUsd).toBe(1.5);
      // A fourth breaks the total cap, whatever is in flight.
      store.updateRun(third.id, { status: 'done' });
      expect(refusal(parent.id, order('one too many'))).toContain('the user capped it at 3');
      // An order that names its own runner, model and budget wins over the defaults.
      store.updateRun(parent.id, { dispatch: { ...rootOf(parent.id, 20), intent: { runner: 'codex', model: 'gpt-5', budgetUsd: 1.5 } } });
      const explicit = dispatchOk(parent.id, order('explicit', { runner: 'claude', model: 'opus', max_cost: 3 }));
      expect(store.getRun(explicit.id)?.runner).toBe('claude');
      expect(store.getRun(explicit.id)?.model).toBe('opus');
      expect(store.getRun(explicit.id)?.dispatch?.budgetUsd).toBe(3);
    }, 40_000);

    it('a root started with an intent runs in a worktree even when the composer opted out, and its prompt carries the intent block', async () => {
      const record = start('mock:monitoring the user asked for a fan-out', undefined, { worktree: false, dispatchIntent: { maxSubtasks: 5 } });
      await waitFor(record.id, (r) => r?.activity === 'monitoring');
      const stored = store.getRun(record.id);
      expect(stored?.dispatch).toEqual({ rootRunId: record.id, intent: { maxSubtasks: 5 } });
      expect(stored?.worktree).toBeUndefined();
      expect(stored?.branch).toBeTruthy();
      expect(notes(record.id).some((n) => n.startsWith('worktree on'))).toBe(true);
    }, 40_000);

    it('refuses against a settled parent and while the feature is off', async () => {
      const parent = store.createRun({ title: 'done', workflow: 'quick-task', task: 't', steps: [] });
      store.updateRun(parent.id, { status: 'done', dispatch: rootOf(parent.id) });
      expect(refusal(parent.id, order('late'))).toContain('already settled');
      process.env.CEZ_DISPATCH = '0';
      expect(refusal(parent.id, order('off'))).toContain('CEZ_DISPATCH=0');
    });
  });

  describe('join decisions', () => {
    const child = (id: string, status: RunRecord['status']): RunRecord => ({
      id, title: id, workflow: 'fixture', task: 'fixture', status, createdAt: new Date(0).toISOString(),
      tokensUsed: 0, archived: false, steps: [],
    });

    it('passes all only when every expected child is done', () => {
      const runs = [child('a', 'done'), child('b', 'done')];
      const join: DispatchJoin = { id: 'all', mode: 'all', expectedChildren: 2, childRunIds: ['a', 'b'], sealed: true, outcome: 'waiting' };
      expect(evaluateDispatchJoin(join, runs).outcome).toBe('passed');
      expect(evaluateDispatchJoin(join, [runs[0]!, child('b', 'failed')]).outcome).toBe('failed');
    });

    it('does not decide any/quorum before the declared fanout is sealed', () => {
      const any: DispatchJoin = { id: 'any', mode: 'any', expectedChildren: 2, childRunIds: ['a'], sealed: false, outcome: 'waiting' };
      const quorum: DispatchJoin = { id: 'q', mode: 'quorum', expectedChildren: 2, quorum: 1, childRunIds: ['a'], sealed: false, outcome: 'waiting' };
      expect(evaluateDispatchJoin(any, [child('a', 'done')]).outcome).toBe('waiting');
      expect(evaluateDispatchJoin(quorum, [child('a', 'done')]).outcome).toBe('waiting');
    });

    it('fails a sealed fanout whose durable membership is shorter than its declared size', () => {
      const join: DispatchJoin = { id: 'lost-member', mode: 'any', expectedChildren: 2, childRunIds: ['a'], sealed: true, outcome: 'waiting' };
      expect(evaluateDispatchJoin(join, [child('a', 'done')]).outcome).toBe('failed');
    });

    it('fails a sealed quorum once the required successes are impossible', () => {
      const runs = [child('a', 'done'), child('b', 'failed'), child('c', 'cancelled')];
      const join: DispatchJoin = { id: 'q', mode: 'quorum', expectedChildren: 3, quorum: 2, childRunIds: ['a', 'b', 'c'], sealed: true, outcome: 'waiting' };
      expect(evaluateDispatchJoin(join, runs)).toMatchObject({ outcome: 'failed', cancelRunIds: [] });
    });

    it('does not treat a blocked or rejected report as a successful child', () => {
      const report = (status: 'blocked' | 'done', result: string, verdict?: 'reject', outcome?: 'unknown') => ({
        status, result, evidence: [], side_effects: [], errors: [], suggestions: [], ...(verdict ? { verdict } : {}), ...(outcome ? { outcome } : {}),
      });
      const blocked = { ...child('blocked', 'done'), dispatch: { rootRunId: 'root', report: report('blocked', 'unknown evidence') } };
      const rejected = { ...child('rejected', 'done'), dispatch: { rootRunId: 'root', report: report('done', 'reviewed', 'reject') } };
      const unknown = { ...child('unknown', 'done'), dispatch: { rootRunId: 'root', report: report('done', 'uncertain', undefined, 'unknown') } };
      const join: DispatchJoin = { id: 'any', mode: 'any', expectedChildren: 3, childRunIds: ['blocked', 'rejected', 'unknown'], sealed: true, outcome: 'waiting' };
      expect(evaluateDispatchJoin(join, [blocked, rejected, unknown]).outcome).toBe('failed');
    });

    it('fails closed for a missing child record or conflicting persisted fork policy', () => {
      const join: DispatchJoin = { id: 'any', mode: 'any', expectedChildren: 2, childRunIds: ['a', 'missing'], sealed: true, outcome: 'waiting' };
      expect(evaluateDispatchJoin(join, [child('a', 'done')]).outcome).toBe('failed');
      const mismatch = { ...child('a', 'done'), dispatch: { rootRunId: 'root', joinId: 'any', joinMode: 'all' as const, joinSize: 2 } };
      expect(evaluateDispatchJoin({ ...join, childRunIds: ['a', 'b'] }, [mismatch, child('b', 'failed')]).outcome).toBe('failed');
    });

    it('persists a successful any-join before cancelling the remaining child', () => {
      const parent = store.createRun({ title: 'parent', workflow: 'fixture', task: 't', steps: [] });
      const first = store.createRun({ title: 'first', workflow: 'fixture', task: 't', steps: [] });
      const second = store.createRun({ title: 'second', workflow: 'fixture', task: 't', steps: [] });
      const join: DispatchJoin = {
        id: 'review', mode: 'any', expectedChildren: 2, childRunIds: [first.id, second.id], sealed: true, outcome: 'waiting',
      };
      store.updateRun(parent.id, { status: 'running', dispatch: { ...rootOf(parent.id), joins: [join] } });
      store.updateRun(first.id, { status: 'done', dispatch: { rootRunId: parent.id, parentRunId: parent.id, joinId: join.id, joinMode: 'any', joinSize: 2 } });
      store.updateRun(second.id, { status: 'queued', dispatch: { rootRunId: parent.id, parentRunId: parent.id, joinId: join.id, joinMode: 'any', joinSize: 2 } });
      const resolve = (manager as unknown as { resolveDispatchJoin: (parentId: string, joinId: string) => DispatchJoin | undefined }).resolveDispatchJoin.bind(manager);
      expect(resolve(parent.id, join.id)?.outcome).toBe('passed');
      expect(store.getRun(second.id)?.status).toBe('cancelled');
      expect(store.getRun(parent.id)?.dispatch?.joins?.[0]?.outcome).toBe('passed');
    });

    it('replays sibling cancellation after a crash following the persisted join decision', () => {
      const parent = store.createRun({ title: 'parent', workflow: 'fixture', task: 't', steps: [] });
      const first = store.createRun({ title: 'winner', workflow: 'fixture', task: 't', steps: [] });
      const second = store.createRun({ title: 'queued loser', workflow: 'fixture', task: 't', steps: [] });
      const join: DispatchJoin = { id: 'crash-window', mode: 'any', expectedChildren: 2, childRunIds: [first.id, second.id], sealed: true, outcome: 'passed' };
      store.updateRun(parent.id, { status: 'cancelled', dispatch: { ...rootOf(parent.id), joins: [join] } });
      store.updateRun(first.id, { status: 'done', dispatch: { rootRunId: parent.id, parentRunId: parent.id, joinId: join.id, joinMode: 'any', joinSize: 2 } });
      store.updateRun(second.id, { status: 'queued', dispatch: { rootRunId: parent.id, parentRunId: parent.id, joinId: join.id, joinMode: 'any', joinSize: 2 } });
      const reconcile = (manager as unknown as { reconcileDispatchJoins: () => void }).reconcileDispatchJoins.bind(manager);
      reconcile();
      expect(store.getRun(parent.id)?.dispatch?.joins?.[0]?.outcome).toBe('passed');
      expect(store.getRun(second.id)?.status).toBe('cancelled');
    });

    it('rebuilds a lost parent join record from durable child links after restart', () => {
      const parent = store.createRun({ title: 'root', workflow: 'w', task: 't', steps: [] });
      store.updateRun(parent.id, { status: 'cancelled', dispatch: rootOf(parent.id) });
      const child = store.createRun({
        title: 'branch', workflow: 'w', task: 't', steps: [],
        dispatch: { rootRunId: parent.id, parentRunId: parent.id, joinId: 'fork-1', joinMode: 'all', joinSize: 1, joinSealed: true },
      });
      store.updateRun(child.id, { status: 'done' });
      const reconcile = (manager as unknown as { reconcileDispatchJoins: () => void }).reconcileDispatchJoins.bind(manager);
      reconcile();
      expect(store.getRun(parent.id)?.dispatch?.joins).toMatchObject([{ id: 'fork-1', outcome: 'passed', childRunIds: [child.id], sealed: true }]);
      const missingParent = store.createRun({ title: 'missing-root', workflow: 'w', task: 't', steps: [] });
      const missingJoin: DispatchJoin = { id: 'lost-fork', mode: 'any', expectedChildren: 1, childRunIds: ['lost-child'], sealed: true, outcome: 'passed' };
      store.updateRun(missingParent.id, { status: 'cancelled', dispatch: { ...rootOf(missingParent.id), joins: [missingJoin] } });
      reconcile();
      expect(store.getRun(missingParent.id)?.dispatch?.joins?.[0]?.outcome).toBe('failed');
    });
  });

  // ---- reports and the settle→parent wake ----------------------------------------------------

  describe('reports', () => {
    it('keeps one implementation session through review, repair, and a second isolated review', async () => {
      const parent = await parkedRoot();
      const implementationSessionId = store.getRun(parent.id)?.steps.find((step) => step.sessionId)?.sessionId;
      expect(implementationSessionId).toBeTruthy();

      const firstReview = dispatchOk(parent.id, order('mock:pause mock:done inspect the implementation', { kind: 'review', review_of: [parent.branch ?? parent.id] }));
      started.push(firstReview.id);
      await waitFor(firstReview.id, (run) => run?.status === 'running');
      await waitFor(firstReview.id, (run) => Boolean(run?.steps.some((step) => Boolean(step.sessionId))));
      const firstReviewSessionId = store.getRun(firstReview.id)?.steps.find((step) => step.sessionId)?.sessionId;
      expect(manager.recordReport(firstReview.id, {
        status: 'done', outcome: 'changes_required', result: 'Found one repairable issue.', evidence: [],
        side_effects: [], errors: [], suggestions: [], verdict: 'changes',
      })).toBe(true);
      await waitFor(firstReview.id, (run) => run?.status === 'done', 40_000);
      await waitFor(parent.id, (run) => (run?.dispatch?.pendingReports?.length ?? 0) === 0, 40_000);
      expect(manager.sendMessage(parent.id, [{ type: 'text', text: 'mock:monitoring repair the review finding in this implementation session' }])).toBe(true);

      const secondReview = dispatchOk(parent.id, order('mock:pause mock:done verify the repair', { kind: 'review', review_of: [parent.branch ?? parent.id] }));
      started.push(secondReview.id);
      await waitFor(secondReview.id, (run) => run?.status === 'running');
      await waitFor(secondReview.id, (run) => Boolean(run?.steps.some((step) => Boolean(step.sessionId))));
      const secondReviewSessionId = store.getRun(secondReview.id)?.steps.find((step) => step.sessionId)?.sessionId;
      expect(manager.recordReport(secondReview.id, {
        status: 'done', outcome: 'passed', result: 'Repair verified.', evidence: ['mock review passed'],
        side_effects: [], errors: [], suggestions: [], verdict: 'approve',
      })).toBe(true);
      await waitFor(secondReview.id, (run) => run?.status === 'done', 40_000);
      await waitFor(parent.id, (run) => (run?.dispatch?.pendingReports?.length ?? 0) === 0, 40_000);
      expect(manager.sendMessage(parent.id, [{ type: 'text', text: 'mock:done finish after the approved re-review' }])).toBe(true);
      await waitFor(parent.id, (run) => run?.status === 'done', 40_000);

      const implementationSessions = store.getRun(parent.id)?.steps.flatMap((step) => step.sessionId ? [step.sessionId] : []) ?? [];
      expect(implementationSessions.length).toBeGreaterThan(1);
      expect(new Set(implementationSessions)).toEqual(new Set([implementationSessionId]));
      expect(firstReviewSessionId).toBeTruthy();
      expect(secondReviewSessionId).toBeTruthy();
      expect(firstReviewSessionId).not.toBe(implementationSessionId);
      expect(secondReviewSessionId).not.toBe(implementationSessionId);
      expect(secondReviewSessionId).not.toBe(firstReviewSessionId);
    }, 90_000);

    it('fails closed when a review node selects a runner without enforceable read-only tools', () => {
      const workflow = versionedWorkflowSchema.parse({
        contract: 'cezar.workflow', schemaVersion: 1, id: 'review-read-only-runner', version: '1.0.0',
        entry: 'review', terminals: ['review'], inputs: [], policyRefs: [], budget: {}, capabilities: [],
        compatibility: { mode: 'versioned-only', minConsumer: '0.14.0', maxConsumer: '0.14.0' },
        nodes: [{ id: 'review', kind: 'agent', dispatchKind: 'review', session: 'new', prompt: 'Review read only.', outcomes: ['passed'] }],
        transitions: [],
      });
      const root = manager.startVersionedRun(workflow, { task: 'keep reviewer read only', runner: 'codex' }, {});
      expect(store.getRun(root.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('read-only tool permissions') });
      expect(childrenOf(root.id)).toHaveLength(0);
    });

    it('records a child’s own report and delivers it into the parent’s open session at settle', async () => {
      const stdinFile = join(repoRoot, 'mock-stdin.ndjson');
      savedEnv.CEZ_MOCK_STDIN_FILE = process.env.CEZ_MOCK_STDIN_FILE;
      process.env.CEZ_MOCK_STDIN_FILE = stdinFile;

      const parent = await parkedRoot();
      const child = start('mock:pause mock:done take the left flank', childOf(parent.id));
      await waitFor(child.id, (r) => r?.status === 'running');
      expect(
        manager.recordReport(child.id, {
          status: 'done',
          result: 'Took the left flank; the login handler now answers 401.',
          evidence: ['npm test -- auth → 12 passed'],
          side_effects: [],
          errors: [],
          suggestions: [],
          verdict: undefined,
        }),
      ).toBe(true);
      await waitFor(child.id, settled, 40_000);

      await waitFor(parent.id, () => stdin(stdinFile).includes('Report from task'));
      const text = delivered(stdinFile, 'Report from task');
      expect(text).toContain(`"${store.getRun(child.id)?.title}"`);
      expect(text).toContain(child.id);
      expect(text).toContain('status done');
      expect(text).toContain('evidence: npm test -- auth → 12 passed');
      // The branch is what makes a report actionable — it is what the parent has to merge.
      expect(text).toContain(`branch ${store.getRun(child.id)?.branch}`);
      // Delivering wakes the monitor: it is working again, not parked.
      expect(store.getRun(parent.id)?.activity).toBeUndefined();
      expect(notes(parent.id).some((n) => n.startsWith('report received from task'))).toBe(true);
      // Persist-then-ACK: the live session taking it retires the pending entry.
      await waitFor(parent.id, (r) => (r?.dispatch?.pendingReports?.length ?? 0) === 0);
      // And the tree directory has the report file.
      expect(readFileSync(join(treeDirOf(parent.id), 'units', child.id.slice(0, 8), 'report.md'), 'utf8')).toContain('"status": "done"');
    }, 60_000);

    it('refuses a report from a run outside any tree', () => {
      const plain = store.createRun({ title: 'plain', workflow: 'quick-task', task: 't', steps: [] });
      expect(manager.recordReport(plain.id, { status: 'done', result: 'x', evidence: [], side_effects: [], errors: [], suggestions: [] })).toBe(false);
    });

    it('persists a pending report for a parent with no session, and flushes it into its next prompt', async () => {
      const stdinFile = join(repoRoot, 'mock-stdin-flush.ndjson');
      savedEnv.CEZ_MOCK_STDIN_FILE = process.env.CEZ_MOCK_STDIN_FILE;
      process.env.CEZ_MOCK_STDIN_FILE = stdinFile;

      // A parent that already FINISHED: no session, so the report can only be persisted.
      const parent = start('mock:done first pass');
      store.updateRun(parent.id, { dispatch: rootOf(parent.id) });
      await waitFor(parent.id, settled);
      const child = start('mock:done take the right flank', childOf(parent.id));
      await waitFor(child.id, settled);
      // Rung 4 of the delivery ladder: a finished parent is continued with the report.
      await waitFor(parent.id, () => stdin(stdinFile).includes('Report from task'), 40_000);
      const text = delivered(stdinFile, 'Report from task');
      expect(text).toContain(child.id);
    }, 60_000);

    it('forwards a settled child’s suggestions to the root’s inbox', async () => {
      const parent = await parkedRoot();
      const child = start('mock:pause mock:done take the right flank', childOf(parent.id));
      await waitFor(child.id, (r) => r?.status === 'running');
      manager.recordReport(child.id, {
        status: 'done',
        result: 'done',
        evidence: [],
        side_effects: [],
        errors: [],
        suggestions: ['split billing out of this order — it is a task of its own'],
      });
      await waitFor(child.id, settled, 40_000);
      const files = readdirSync(join(treeDirOf(parent.id), 'inbox', 'root'));
      const suggestion = files.find((name) => name.includes('suggestions'));
      expect(suggestion).toBeTruthy();
      expect(readFileSync(join(treeDirOf(parent.id), 'inbox', 'root', suggestion!), 'utf8')).toContain('split billing out of this order');
    }, 60_000);
  });

  // ---- the tree directory (the filesystem channel) -------------------------------------------

  describe('the tree directory', () => {
    it('wakes a parked parent when a file lands in its inbox', async () => {
      const stdinFile = join(repoRoot, 'mock-stdin-inbox.ndjson');
      savedEnv.CEZ_MOCK_STDIN_FILE = process.env.CEZ_MOCK_STDIN_FILE;
      process.env.CEZ_MOCK_STDIN_FILE = stdinFile;

      const parent = await parkedRoot();
      // A child whose turn ends is the SIGNAL: it wrote into the root's inbox, then finished.
      const inbox = join(treeDirOf(parent.id), 'inbox', 'root');
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, 'scope-question.md'), '# Scope\n\nMay I touch billing?\n');
      const child = start('mock:done take the left flank', childOf(parent.id));
      await waitFor(child.id, settled);
      await waitFor(parent.id, () => stdin(stdinFile).includes('Tree inbox'));
      expect(delivered(stdinFile, 'Tree inbox')).toContain(join(inbox, 'scope-question.md'));
      expect(store.getRun(parent.id)?.dispatch?.inboxSeenAt).toBeTruthy();
      expect(notes(parent.id).some((n) => n.includes('new tree inbox message'))).toBe(true);
    }, 60_000);

    it('hands a working task its own inbox at turn end instead of parking it', async () => {
      const stdinFile = join(repoRoot, 'mock-stdin-own-inbox.ndjson');
      savedEnv.CEZ_MOCK_STDIN_FILE = process.env.CEZ_MOCK_STDIN_FILE;
      process.env.CEZ_MOCK_STDIN_FILE = stdinFile;
      const root = store.createRun({ title: 'root', workflow: 'quick-task', task: 'hold', steps: [] });
      store.updateRun(root.id, { status: 'waiting', dispatch: rootOf(root.id) });
      const child = start('mock:pause work on it', childOf(root.id), { autonomous: true });
      await waitFor(child.id, () => stdin(stdinFile).includes('work on it'));
      const inbox = join(treeDirOf(root.id), 'inbox', child.id.slice(0, 8));
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, 'from-parent.md'), '# Redirect\n\nStop at the API layer.\n');
      await waitFor(child.id, settled, 40_000);
      expect(store.getRun(child.id)?.status).toBe('done'); // the mock answers a digest with DONE
      expect(delivered(stdinFile, '## Tree inbox')).toContain('from-parent.md');
      expect(notes(child.id).some((n) => n.startsWith('tree inbox digest delivered into the session at turn end'))).toBe(true);
    }, 60_000);

    it('keeps an inbox delivery ahead of a monitoring park at turn end', async () => {
      const stdinFile = join(repoRoot, 'mock-stdin-own-inbox-monitoring.ndjson');
      savedEnv.CEZ_MOCK_STDIN_FILE = process.env.CEZ_MOCK_STDIN_FILE;
      process.env.CEZ_MOCK_STDIN_FILE = stdinFile;
      const root = store.createRun({ title: 'root', workflow: 'quick-task', task: 'hold', steps: [] });
      store.updateRun(root.id, { status: 'waiting', dispatch: rootOf(root.id) });
      const child = start('mock:pause mock:monitoring keep watching', childOf(root.id), { autonomous: true });
      await waitFor(child.id, () => stdin(stdinFile).includes('keep watching'));
      const inbox = join(treeDirOf(root.id), 'inbox', child.id.slice(0, 8));
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, 'from-parent.md'), '# Redirect\n\nKeep going with the parent\'s latest instruction.\n');

      // The note is persisted immediately after sendMessage accepts the delivery, while the
      // mock's stdin writer may flush its JSON line a tick later. Wait for the actual inbound
      // evidence before asking `delivered` to parse the file; otherwise the regression itself
      // races the fixture and can report a false failure under suite load.
      await waitFor(child.id, () => stdin(stdinFile).includes('## Tree inbox'), 40_000);
      expect(delivered(stdinFile, '## Tree inbox')).toContain('from-parent.md');
      expect(notes(child.id).some((n) => n.startsWith('tree inbox digest delivered into the session at turn end'))).toBe(true);
      expect(store.getRun(child.id)?.activity).toBeUndefined();
    }, 60_000);

    it('tells a parked parent, through its inbox, that a child is blocked on the Guard', async () => {
      const stdinFile = join(repoRoot, 'mock-stdin-blocked.ndjson');
      savedEnv.CEZ_MOCK_STDIN_FILE = process.env.CEZ_MOCK_STDIN_FILE;
      process.env.CEZ_MOCK_STDIN_FILE = stdinFile;
      const parent = await parkedRoot();
      const child = start('mock:ask which library?', childOf(parent.id), { autonomous: true });
      await waitFor(child.id, (r) => r?.status === 'waiting');
      expect(store.getRun(child.id)?.dispatch?.pendingAsk?.questions).toHaveLength(1);
      const rootInbox = join(treeDirOf(parent.id), 'inbox', 'root');
      const blocked = readdirSync(rootInbox).find((name) => name.includes('blocked-on-a-guard'));
      expect(blocked).toBeTruthy();
      await waitFor(parent.id, () => stdin(stdinFile).includes('## Tree inbox'));
      expect(store.getRun(child.id)?.status).toBe('waiting'); // nothing answered its question
    }, 60_000);
  });

  // ---- the pending question (the Guard) ------------------------------------------------------

  describe('pendingAsk', () => {
    it('records a dispatched run’s question when it parks and clears it when an answer is delivered', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const record = start('mock:ask which library?', rootOf('m8'), { autonomous: true });
      await waitFor(record.id, (r) => r?.status === 'waiting');
      expect(store.getRun(record.id)?.dispatch?.pendingAsk?.questions).toHaveLength(1);
      expect(manager.sendMessage(record.id, [{ type: 'text', text: 'mock:done use date-fns' }])).toBe(true);
      expect(store.getRun(record.id)?.dispatch?.pendingAsk).toBeUndefined();
      await waitFor(record.id, settled);
    }, 40_000);

    // A card may now carry up to ASK_MAX_QUESTIONS, but this RECORD field may not: it is read
    // back by an all-or-nothing index parser, so an over-long list in a fresh `runs.json` would
    // cost an older cezar every task in the project, not just the park.
    it('truncates a six-question park to the record’s bound and counts the rest', async () => {
      const parent = await parkedRoot();
      const child = start('mock:ask-many pick a path', childOf(parent.id), { autonomous: true });
      await waitFor(child.id, (r) => r?.status === 'waiting');
      const parked = store.getRun(child.id);
      expect(parked?.dispatch?.pendingAsk?.questions).toHaveLength(PENDING_ASK_MAX_QUESTIONS);
      expect(parked?.dispatch?.pendingAsk?.omittedQuestions).toBe(6 - PENDING_ASK_MAX_QUESTIONS);
      // The point of the truncation: the record still parses, so the index keeps every task.
      expect(runRecordSchema.safeParse(parked).success).toBe(true);
      // Nothing is hidden from the parent — the Guard inbox message is a file under no schema.
      const rootInbox = join(treeDirOf(parent.id), 'inbox', 'root');
      const guard = readdirSync(rootInbox).find((name) => name.includes('blocked-on-a-guard'));
      expect(guard).toBeTruthy();
      const body = readFileSync(join(rootInbox, guard!), 'utf8');
      for (let index = 0; index < 6; index += 1) {
        expect(body).toContain(`Decision ${index} — which way?`);
      }
    }, 60_000);
  });

  // ---- brakes -------------------------------------------------------------------------------

  it('parks an over-budget run at waiting — no autonomous nudge, no wake timer', async () => {
    reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
    const record = start('mock:monitoring keep going', rootOf('m6', 0), { autonomous: true });
    await waitFor(record.id, (r) => r?.status === 'waiting');
    expect(store.getRun(record.id)?.dispatch?.overBudget).toBe(true);
    expect(store.getRun(record.id)?.activity).toBeUndefined();
    expect(activeState(record.id)?.monitoringWakeTimer).toBeUndefined();
    expect(notes(record.id).some((n) => n.startsWith('budget spent'))).toBe(true);
  }, 40_000);

  it('cancels a whole subtree, deepest first', async () => {
    const root = start('mock:monitoring hold', rootOf('m7'));
    await waitFor(root.id, (r) => r?.activity === 'monitoring');
    const child = store.createRun({ title: 'child', workflow: '(planned)', task: 't', steps: [] });
    store.updateRun(child.id, { status: 'waiting', dispatch: childOf(root.id) });
    const grandchild = store.createRun({ title: 'grandchild', workflow: '(planned)', task: 't', steps: [] });
    store.updateRun(grandchild.id, { status: 'queued', dispatch: { rootRunId: root.id, parentRunId: child.id } });
    // Queued in the manager's own queue so `cancel` has something to drop.
    (manager as unknown as { queue: string[] }).queue.push(grandchild.id);
    expect(manager.cancel(root.id)).toBe(true);
    expect(store.getRun(grandchild.id)?.status).toBe('cancelled');
    await waitFor(root.id, (r) => r?.status === 'cancelled');
  }, 40_000);

  // ---- the Guard: an autonomous dispatched run never answers its own CEZ:ASK ------------------

  describe('the Guard', () => {
    it('parks a dispatched run at waiting with the ask card instead of nudging it onward', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const record = start('mock:ask which library?', rootOf('m9'), { autonomous: true });
      await waitFor(record.id, (r) => r?.status === 'waiting');
      expect(notes(record.id).some((n) => n.includes('autonomous — continuing'))).toBe(false);
    }, 40_000);

    it('leaves a NON-dispatch autonomous run auto-continuing, exactly as before', async () => {
      reboot({ maxParallel: 1, maxMonitoringSessions: 0 });
      const record = start('mock:ask mock:autonomous which library?', undefined, { autonomous: true });
      await waitFor(record.id, settled);
      expect(notes(record.id).some((n) => n.includes('autonomous — continuing'))).toBe(true);
    }, 40_000);
  });

  // ---- the counterweight ---------------------------------------------------------------------

  describe('a run with no dispatch is untouched', () => {
    it('settles the way it always did, with no tree directory and no dispatch env', async () => {
      const record = start('mock:done plain task');
      await waitFor(record.id, settled);
      expect(store.getRun(record.id)?.dispatch).toBeUndefined();
      expect(existsSync(join(repoRoot, '.ai/cezar/dispatch'))).toBe(false);
    }, 40_000);
  });
});
