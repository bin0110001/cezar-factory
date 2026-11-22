import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { versionedWorkflowSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';

const roots: string[] = [];
const managers: RunManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function gateWorkflow(policy: string) {
  return versionedWorkflowSchema.parse({
    contract: 'cezar.workflow', schemaVersion: 1, id: `runtime-policy-gate-${policy.replaceAll('.', '-')}`, version: '1.0.0',
    entry: 'gate', terminals: ['approved', 'denied'], inputs: [{ name: 'candidateId', type: 'string', required: true }],
    nodes: [
      { id: 'gate', kind: 'policy_gate', policy, outcomes: ['passed', 'blocked'], outputs: [{ name: 'status', type: 'string' }, { name: 'reasonCode', type: 'string' }] },
      { id: 'approved', kind: 'return', source: 'gate', outcomes: ['passed'], outputs: [{ name: 'status', type: 'string' }, { name: 'reasonCode', type: 'string' }] },
      { id: 'denied', kind: 'return', source: 'gate', outcomes: ['blocked'], outputs: [{ name: 'status', type: 'string' }, { name: 'reasonCode', type: 'string' }] },
    ],
    transitions: [
      { from: 'gate', outcome: 'passed', to: 'approved', order: 0 },
      { from: 'gate', outcome: 'blocked', to: 'denied', order: 1 },
    ],
    policyRefs: [], budget: {}, capabilities: [],
    compatibility: { mode: 'versioned-only', minConsumer: '0.14.0', maxConsumer: '0.14.0' },
  });
}

async function waitForStatus(store: RunStore, id: string, status: 'done' | 'failed') {
  const deadline = Date.now() + 2_000;
  while (store.getRun(id)?.status !== status) {
    if (Date.now() >= deadline) throw new Error(`workflow did not reach ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('versioned policy gate runtime', () => {
  it('executes registered read-only gates and fails closed when a handler is absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-policy-gate-'));
    roots.push(root);
    const store = RunStore.open(join(root, '.ai', 'cezar'));
    const manager = new RunManager(store, root, {
      versionedWorkflowPolicyGates: {
        'fixture.candidate-gate': {
          evaluate: (request) => ({
            outcome: request.inputs.candidateId === 'candidate-1' ? 'passed' : 'blocked',
            outputs: { status: request.inputs.candidateId === 'candidate-1' ? 'passed' : 'blocked', reasonCode: 'fixture-result' },
          }),
        },
      },
    });
    managers.push(manager);

    const approved = manager.startVersionedRun(gateWorkflow('fixture.candidate-gate'), { task: 'check candidate' }, { candidateId: 'candidate-1' });
    await waitForStatus(store, approved.id, 'done');
    expect(store.getRun(approved.id)?.workflowExecution).toMatchObject({
      status: 'done', outcomes: { gate: 'passed', approved: 'passed' }, outputs: { gate: { status: 'passed', reasonCode: 'fixture-result' } },
    });

    const refused = manager.startVersionedRun(gateWorkflow('missing.policy'), { task: 'check missing gate' }, { candidateId: 'candidate-1' });
    await waitForStatus(store, refused.id, 'failed');
    expect(store.getRun(refused.id)?.error).toContain('has no registered read-only evaluator');
  });
});
