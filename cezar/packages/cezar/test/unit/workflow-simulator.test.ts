import assert from 'node:assert/strict';
import test from 'node:test';
import { simulateWorkflow, versionedWorkflowSchema } from '@open-mercato/cezar-contract';

const base = {
  contract: 'cezar.workflow', schemaVersion: 1, id: 'test.graph', version: '1.0.0', entry: 'start', terminals: ['done'],
  nodes: [
    { id: 'start', kind: 'action', action: 'fixture', outcomes: ['passed'], capabilities: [], session: 'none' },
    { id: 'done', kind: 'action', action: 'fixture', outcomes: ['passed'], capabilities: [], session: 'none' },
  ],
  transitions: [{ from: 'start', outcome: 'passed', to: 'done', order: 0 }],
  compatibility: { mode: 'versioned-only', minConsumer: '1.0.0', maxConsumer: '1.0.0' },
};

test('workflow simulator follows explicit fixture outcomes without executing effects', async () => {
  const workflow = versionedWorkflowSchema.parse(base);
  const result = await simulateWorkflow({ workflow, scenarios: [{ id: 'happy', outcomes: { start: ['passed'] } }] });
  assert.equal(result.scenarios[0]?.status, 'completed');
  assert.deepEqual(result.scenarios[0]?.steps.map((step) => step.node), ['start']);
});

test('workflow simulator keeps an unknown guard unresolved and waits without a trigger', async () => {
  const guarded = versionedWorkflowSchema.parse({ ...base,
    transitions: [{ from: 'start', outcome: 'passed', to: 'done', order: 0, when: { op: 'outcome_is', node: 'done', outcome: 'passed' } }],
  });
  const unknown = await simulateWorkflow({ workflow: guarded, scenarios: [{ id: 'unknown', outcomes: { start: ['passed'] } }] });
  assert.equal(unknown.scenarios[0]?.status, 'unknown');

  const waiting = versionedWorkflowSchema.parse({ ...base, entry: 'wait', nodes: [
    { id: 'wait', kind: 'wait', reason: 'human review', waitFor: 'human', outcomes: ['passed'], session: 'none' }, base.nodes[1],
  ], transitions: [{ from: 'wait', outcome: 'passed', to: 'done', order: 0 }] });
  const result = await simulateWorkflow({ workflow: waiting, scenarios: [{ id: 'waiting', outcomes: {} }] });
  assert.equal(result.scenarios[0]?.status, 'waiting');
});

test('workflow simulator reports a bounded loop witness and comparison without migration', async () => {
  const loop = versionedWorkflowSchema.parse({ ...base, entry: 'loop', nodes: [
    { id: 'loop', kind: 'action', action: 'fixture', outcomes: ['passed'], capabilities: [], session: 'none' },
    base.nodes[1],
  ], transitions: [{ from: 'loop', outcome: 'passed', to: 'loop', order: 0 }] });
  const result = await simulateWorkflow({ workflow: loop, compareTo: loop, scenarios: [{ id: 'loop', outcomes: { loop: ['passed', 'passed', 'passed'] }, maxSteps: 3 }] }, 2);
  assert.equal(result.scenarios[0]?.status, 'budget-exhausted');
  assert.ok((result.scenarios[0]?.cycleWitness?.length ?? 0) >= 2);
  assert.equal(result.comparison?.activePinnedRuns, 2);
  assert.equal(result.comparison?.migration, 'none');
});

test('workflow simulator proves a fixture-bounded loop can exit', async () => {
  const workflow = versionedWorkflowSchema.parse({ ...base, entry: 'loop', nodes: [
    { id: 'loop', kind: 'action', action: 'fixture', outcomes: ['passed', 'blocked'], capabilities: [], session: 'none' }, base.nodes[1],
  ], transitions: [
    { from: 'loop', outcome: 'passed', to: 'loop', order: 0 },
    { from: 'loop', outcome: 'blocked', to: 'done', order: 1 },
  ] });
  const result = await simulateWorkflow({ workflow, scenarios: [{ id: 'bounded', outcomes: { loop: ['passed', 'passed', 'blocked'] } }] });
  assert.equal(result.scenarios[0]?.status, 'completed');
  assert.equal(result.scenarios[0]?.steps.length, 3);
});

test('workflow simulator keeps worker loss, joined-child failure, and reentrant child routing fixture-only', async () => {
  const workerLoss = versionedWorkflowSchema.parse({ ...base, nodes: [
    { id: 'start', kind: 'agent', prompt: 'fixture only', outcomes: ['unknown'], session: 'continue' }, base.nodes[1],
  ], transitions: [{ from: 'start', outcome: 'unknown', to: 'done', order: 0 }] });
  const lost = await simulateWorkflow({ workflow: workerLoss, scenarios: [{ id: 'worker-loss', outcomes: { start: ['unknown'] } }] });
  assert.equal(lost.scenarios[0]?.status, 'completed');
  assert.equal(lost.scenarios[0]?.steps[0]?.outcome, 'unknown');

  const joinedFailure = versionedWorkflowSchema.parse({ ...base, entry: 'fork', nodes: [
    { id: 'fork', kind: 'fork', children: ['left', 'right'], join: { mode: 'all' }, outcomes: ['passed', 'blocked'], session: 'none' },
    { id: 'left', kind: 'agent', prompt: 'fixture only', outcomes: ['passed', 'blocked'], session: 'new' },
    { id: 'right', kind: 'agent', prompt: 'fixture only', outcomes: ['passed', 'blocked'], session: 'new' },
    { id: 'join', kind: 'join', fork: 'fork', outcomes: ['passed', 'blocked'], session: 'none' }, base.nodes[1],
  ], transitions: [
    { from: 'fork', outcome: 'passed', to: 'join', order: 0 }, { from: 'fork', outcome: 'blocked', to: 'done', order: 1 },
    { from: 'left', outcome: 'passed', to: 'join', order: 0 }, { from: 'left', outcome: 'blocked', to: 'join', order: 1 },
    { from: 'right', outcome: 'passed', to: 'join', order: 0 }, { from: 'right', outcome: 'blocked', to: 'join', order: 1 },
    { from: 'join', outcome: 'passed', to: 'done', order: 0 }, { from: 'join', outcome: 'blocked', to: 'done', order: 1 },
  ] });
  const joined = await simulateWorkflow({ workflow: joinedFailure, scenarios: [{ id: 'joined-child-failure', outcomes: { fork: ['blocked'] } }] });
  assert.equal(joined.scenarios[0]?.status, 'completed');
  assert.match(joined.scenarios[0]?.steps[0]?.note ?? '', /no child or worker was started/);

  const reentrant = versionedWorkflowSchema.parse({ ...base, entry: 'child', nodes: [
    { id: 'child', kind: 'child_workflow', workflow: 'example.child', version: '1.0.0', outcomes: ['needs_input', 'passed'], session: 'none' },
    { id: 'route', kind: 'action', action: 'fixture', outcomes: ['passed'], capabilities: [], session: 'none' }, base.nodes[1],
  ], transitions: [
    { from: 'child', outcome: 'needs_input', to: 'route', order: 0 }, { from: 'route', outcome: 'passed', to: 'child', order: 0 },
    { from: 'child', outcome: 'passed', to: 'done', order: 1 },
  ] });
  const routed = await simulateWorkflow({ workflow: reentrant, scenarios: [{ id: 'reentrant-child', outcomes: { child: ['needs_input', 'passed'], route: ['passed'] } }] });
  assert.equal(routed.scenarios[0]?.status, 'completed');
  assert.deepEqual(routed.scenarios[0]?.steps.map((step) => step.node), ['child', 'route', 'child']);
});
