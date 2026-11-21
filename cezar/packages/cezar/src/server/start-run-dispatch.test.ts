import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { initializeWorkflowExecution, versionedWorkflowSchema, type VersionedWorkflow } from '@open-mercato/cezar-contract';

/**
 * `POST /runs` with the composer's Dispatch toggle (spec 2026-09-10-dispatch): the body's
 * `dispatch` intent reaches `startRun` as `dispatchIntent` while the capability is on, and is
 * dropped — the run still starts — while it is off. The route validates the intent's shape
 * strictly, so a misspelled limit is a 400 rather than a brake that never fired.
 */
describe('POST /runs and the dispatch intent', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let inputs: StartRunInput[];
  let versionedStarts: Array<{ workflow: VersionedWorkflow; input: StartRunInput; values: Record<string, unknown> }>;
  let eventResumes: Array<{ id: string; trigger: { kind: 'event'; event: string; eventId: string } }>;
  const savedFlag = process.env.CEZ_DISPATCH;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-startrun-dispatch-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    inputs = [];
    versionedStarts = [];
    eventResumes = [];
    delete process.env.CEZ_DISPATCH;
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        inputs.push(input);
        return store.createRun({ title: 't', workflow: 'quick-task', task: input.task, steps: [] });
      },
      startVersionedRun: (workflow: VersionedWorkflow, input: StartRunInput, values: Record<string, unknown>) => {
        versionedStarts.push({ workflow, input, values });
        return store.createRun({ title: 'v', workflow: `${workflow.id}@${workflow.version}`, task: input.task, steps: [] });
      },
      resumeVersionedRun: (id: string, trigger: { kind: 'event'; event: string; eventId: string }) => {
        eventResumes.push({ id, trigger });
        return { ok: true };
      },
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.CEZ_DISPATCH;
    else process.env.CEZ_DISPATCH = savedFlag;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const post = (body: unknown) =>
    apiRequest(app, '/api/v1/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('threads the intent into startRun while dispatch is on (the default)', async () => {
    const res = await post({ steps: [{ id: 'work', prompt: '{{task}}' }], task: 'split this', dispatch: { maxSubtasks: 10, inFlight: 2, model: 'sonnet' } });
    expect(res.status).toBe(201);
    expect(inputs[0]?.dispatchIntent).toEqual({ maxSubtasks: 10, inFlight: 2, model: 'sonnet' });
  });

  it('resolves and starts an exact versioned workflow identity with typed input values', async () => {
    const dir = join(repoRoot, '.ai/cezar/workflows');
    mkdirSync(dir, { recursive: true });
    const workflow = {
      contract: 'cezar.workflow', schemaVersion: 1, id: 'ticket-review', version: '1.2.0',
      entry: 'wait', terminals: ['wait'], inputs: [{ name: 'ticket', type: 'string', required: true }],
      nodes: [{ id: 'wait', kind: 'wait', reason: 'approval', outcomes: ['passed'] }], transitions: [],
      budget: {}, policyRefs: [], capabilities: [],
      compatibility: { mode: 'versioned-only', minConsumer: '0.14.0', maxConsumer: '0.14.0' },
    };
    writeFileSync(join(dir, 'ticket-review.workflow.json'), JSON.stringify(workflow));
    const res = await post({ workflow: 'ticket-review@1.2.0', task: 'review requested ticket', inputs: { ticket: 'ABC-123' }, dispatch: { budgetUsd: 4 } });
    expect(res.status).toBe(201);
    expect(versionedStarts).toMatchObject([{ workflow: { id: 'ticket-review', version: '1.2.0' }, input: { task: 'review requested ticket', dispatchIntent: { budgetUsd: 4 } }, values: { ticket: 'ABC-123' } }]);
    expect(inputs).toHaveLength(0);
  });

  it('routes an identified event delivery only to a persisted versioned run', async () => {
    const workflow = versionedWorkflowSchema.parse({
      contract: 'cezar.workflow', schemaVersion: 1, id: 'event-resume', version: '1.0.0',
      entry: 'approval', terminals: ['approval'], inputs: [], policyRefs: [], budget: {}, capabilities: [],
      nodes: [{ id: 'approval', kind: 'wait', reason: 'approval event', waitFor: 'event', event: 'issue.approved', outcomes: ['passed'] }],
      transitions: [], compatibility: { mode: 'versioned-only', minConsumer: '0.14.0', maxConsumer: '0.14.0' },
    });
    const execution = initializeWorkflowExecution(workflow, 'a'.repeat(64), [], {});
    const run = store.createRun({ title: 'event wait', workflow: 'event-resume@1.0.0', task: 'await approval', workflowExecution: execution, steps: [] });
    const res = await apiRequest(app, `/api/v1/runs/${run.id}/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'issue.approved', eventId: 'hook-delivery-1' }),
    });
    expect(res.status).toBe(200);
    expect(eventResumes).toEqual([{ id: run.id, trigger: { kind: 'event', event: 'issue.approved', eventId: 'hook-delivery-1' } }]);
    const legacy = store.createRun({ title: 'legacy', workflow: 'quick-task', task: 'no event wait', steps: [] });
    const rejected = await apiRequest(app, `/api/v1/runs/${legacy.id}/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'issue.approved', eventId: 'hook-delivery-2' }),
    });
    expect(rejected.status).toBe(409);
  });

  it('the bare toggle is an empty intent, and no toggle is no intent', async () => {
    expect((await post({ steps: [{ id: 'work', prompt: '{{task}}' }], task: 'split this', dispatch: {} })).status).toBe(201);
    expect(inputs[0]?.dispatchIntent).toEqual({});
    expect((await post({ steps: [{ id: 'work', prompt: '{{task}}' }], task: 'plain' })).status).toBe(201);
    expect(inputs[1]?.dispatchIntent).toBeUndefined();
  });

  it('drops the intent — still starting the run — while CEZ_DISPATCH=0', async () => {
    process.env.CEZ_DISPATCH = '0';
    const res = await post({ steps: [{ id: 'work', prompt: '{{task}}' }], task: 'split this', dispatch: { maxSubtasks: 3 } });
    expect(res.status).toBe(201);
    expect(inputs[0]?.dispatchIntent).toBeUndefined();
  });

  it('400s an intent outside the contract: an unknown key, or a cap above the engine’s', async () => {
    expect((await post({ steps: [{ id: 'work', prompt: '{{task}}' }], task: 't', dispatch: { maxSubtask: 3 } })).status).toBe(400);
    expect((await post({ steps: [{ id: 'work', prompt: '{{task}}' }], task: 't', dispatch: { inFlight: 9 } })).status).toBe(400);
    expect(inputs).toHaveLength(0);
  });
});
