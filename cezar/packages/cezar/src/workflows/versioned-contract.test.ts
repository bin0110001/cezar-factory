import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { beginWorkflowNode, canonicalJson, completeWorkflowNode, evaluateGuard, initializeWorkflowExecution, resumeWorkflowWait, selectWorkflowTransition, versionedWorkflowEventInputSchema, versionedWorkflowSchema } from '@open-mercato/cezar-contract';
import { normalizeWorkflowDoc, workflowFileSchema } from './types.ts';
import { workflowDefinitionPinMatches } from './run.ts';
import type { RunRecord } from '../runs/store.ts';

function sample(id: string, kind: 'agent' | 'validator' | 'policy_gate' | 'action' | 'verification' = 'agent') {
  const node = kind === 'agent' ? { id: 'work', kind, prompt: 'Complete {{task}}', outcomes: ['passed', 'changes_required', 'needs_input'] }
    : kind === 'validator' ? { id: 'work', kind, validator: 'local-suite', outcomes: ['passed', 'investigate'] }
      : kind === 'verification' ? { id: 'work', kind, suite: 'quick', outcomes: ['passed', 'changes_required', 'unknown', 'interrupted'] }
      : kind === 'policy_gate' ? { id: 'work', kind, policy: 'review-required', outcomes: ['passed', 'blocked'] }
        : { id: 'work', kind, action: 'factory.issue.deliver', capabilities: ['github.issue.write'], outcomes: ['passed', 'investigate'] };
  const outcomes = node.outcomes;
  return {
    contract: 'cezar.workflow', schemaVersion: 1, id, version: '1.0.0', entry: 'work', terminals: ['done'],
    capabilities: kind === 'action' ? ['github.issue.write'] : [],
    nodes: [node, { id: 'done', kind: 'wait', reason: 'Workflow complete', outcomes: ['passed'] }],
    transitions: outcomes.map((outcome, order) => ({ from: 'work', outcome, to: 'done', order })),
    compatibility: { mode: 'legacy-adapter', minConsumer: '0.14.0', maxConsumer: '1.99.99' },
  };
}

describe('versioned workflow contract', () => {
  it('accepts issue delivery, investigation, review, and repair definitions', () => {
    for (const value of [sample('issue-delivery', 'action'), sample('investigation', 'agent'), sample('review', 'policy_gate'), sample('repair', 'validator'), sample('verify', 'verification')]) {
      expect(versionedWorkflowSchema.safeParse(value).success).toBe(true);
    }
  });

  it('accepts only a typed suite on verification nodes', () => {
    const workflow = sample('verify', 'verification');
    expect(versionedWorkflowSchema.safeParse({ ...workflow, nodes: [{ ...workflow.nodes[0], suite: '  ' }, workflow.nodes[1]] }).success).toBe(false);
    expect(versionedWorkflowSchema.safeParse({ ...workflow, nodes: [{ ...workflow.nodes[0], command: 'npm test' }, workflow.nodes[1]] }).success).toBe(false);
    expect(versionedWorkflowSchema.safeParse({ ...workflow, nodes: [{ ...workflow.nodes[0], outcomes: ['passed'] }, workflow.nodes[1]] }).success).toBe(false);
  });

  it('routes uncertain outcomes through a child and returns prior typed outcomes and outputs', () => {
    const workflow = versionedWorkflowSchema.parse({
      contract: 'cezar.workflow', schemaVersion: 1, id: 'investigation-caller', version: '1.0.0', entry: 'triage',
      terminals: ['return-triage', 'return-investigation'], inputs: [], policyRefs: [], budget: {}, capabilities: [],
      compatibility: { mode: 'versioned-only', minConsumer: '0.14.0', maxConsumer: '0.14.0' },
      nodes: [
        { id: 'triage', kind: 'agent', prompt: 'classify', outcomes: ['passed', 'unknown'], outputs: [{ name: 'result', type: 'object' }] },
        { id: 'investigate', kind: 'child_workflow', workflow: 'factory.investigation', version: '1.0.0', outcomes: ['ready', 'needs_input'], outputs: [{ name: 'result', type: 'object' }] },
        { id: 'return-triage', kind: 'return', source: 'triage', outcomes: ['passed'], outputs: [{ name: 'result', type: 'object' }] },
        { id: 'return-investigation', kind: 'return', source: 'investigate', outcomes: ['ready', 'needs_input'], outputs: [{ name: 'result', type: 'object' }] },
      ],
      transitions: [
        { from: 'triage', outcome: 'passed', to: 'return-triage', order: 0 },
        { from: 'triage', outcome: 'unknown', to: 'investigate', order: 1 },
        { from: 'investigate', outcome: 'ready', to: 'return-investigation', order: 0 },
        { from: 'investigate', outcome: 'needs_input', to: 'return-investigation', order: 1 },
      ],
    });
    let execution = initializeWorkflowExecution(workflow, 'a'.repeat(64), [], {});
    const triage = beginWorkflowNode(execution, 'triage');
    execution = completeWorkflowNode(triage.execution, 'triage', 'unknown', { result: { issue: 7 } }, triage.transitionId).execution;
    expect(execution.ready).toEqual(['investigate']);
    const investigation = beginWorkflowNode(execution, 'investigate');
    execution = completeWorkflowNode(investigation.execution, 'investigate', 'needs_input', { result: { issue: 7, evidenceRefs: [] } }, investigation.transitionId).execution;
    const returned = beginWorkflowNode(execution, 'return-investigation');
    const completed = completeWorkflowNode(returned.execution, 'return-investigation', 'needs_input', execution.outputs.investigate, returned.transitionId);
    expect(completed.execution).toMatchObject({ status: 'done', outcomes: { investigate: 'needs_input', 'return-investigation': 'needs_input' }, outputs: { 'return-investigation': { result: { issue: 7, evidenceRefs: [] } } } });
    expect(versionedWorkflowSchema.safeParse({ ...workflow, terminals: ['return-triage'] }).success).toBe(false);
    expect(versionedWorkflowSchema.safeParse({ ...workflow, nodes: workflow.nodes.map((node) => node.id === 'return-investigation' ? { ...node, outcomes: ['unknown'] } : node) }).success).toBe(false);
  });

  it('rejects missing outcomes, invalid references, unsupported capabilities, and unsafe guards', () => {
    const valid = sample('issue-delivery', 'action');
    expect(versionedWorkflowSchema.safeParse({ ...valid, nodes: [{ ...valid.nodes[0], outcomes: [] }, valid.nodes[1]] }).success).toBe(false);
    expect(versionedWorkflowSchema.safeParse({ ...valid, entry: 'missing' }).success).toBe(false);
    expect(versionedWorkflowSchema.safeParse({ ...valid, capabilities: [] }).success).toBe(false);
    expect(versionedWorkflowSchema.safeParse({ ...valid, transitions: [...valid.transitions, { ...valid.transitions[0], order: 0 }] }).success).toBe(false);
    expect(versionedWorkflowSchema.safeParse({ ...valid, transitions: [{ ...valid.transitions[0], when: { op: 'javascript', source: 'return true' } }] }).success).toBe(false);
    const quorum = { ...valid, nodes: [{ id: 'parallel', kind: 'fork', children: ['work'], join: { mode: 'quorum', count: 2 }, outcomes: ['passed'] }, ...valid.nodes.slice(1)] };
    expect(versionedWorkflowSchema.safeParse(quorum).success).toBe(false);
    const externalBase = sample('external-session');
    const externalSession = { ...externalBase, nodes: [{ ...externalBase.nodes[0], session: 'external' }, ...externalBase.nodes.slice(1)] };
    expect(versionedWorkflowSchema.safeParse(externalSession).success).toBe(false);
    expect(versionedWorkflowSchema.safeParse({ ...externalSession, capabilities: ['session.external'] }).success).toBe(true);
  });

  it('canonicalizes property order and fails closed for missing guard values', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
    expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
    expect(evaluateGuard({ op: 'input_equals', path: 'decision.approved', value: true }, { outcomes: {}, inputs: {} })).toBe('unknown');
    expect(evaluateGuard({ op: 'outcome_is', node: 'missing', outcome: 'passed' }, { outcomes: {}, inputs: {} })).toBe('unknown');
  });

  it('routes by explicit order and returns unknown instead of falling through', () => {
    const base = sample('routing');
    const workflow = versionedWorkflowSchema.parse({ ...base,
      transitions: [
        ...base.transitions.filter((transition) => transition.outcome !== 'passed').map((transition, index) => ({ ...transition, order: index + 2 })),
        { from: 'work', outcome: 'passed', to: 'done', order: 1 },
        { from: 'work', outcome: 'passed', to: 'done', order: 0, when: { op: 'input_equals', path: 'approved', value: true } },
      ],
    });
    expect(selectWorkflowTransition(workflow, 'work', 'passed', { outcomes: {}, inputs: {} })).toMatchObject({ status: 'unknown' });
    expect(selectWorkflowTransition(workflow, 'work', 'passed', { outcomes: {}, inputs: { approved: false } })).toMatchObject({ status: 'selected', order: 1 });
    expect(selectWorkflowTransition(workflow, 'work', 'passed', { outcomes: {}, inputs: { approved: true } })).toMatchObject({ status: 'selected', order: 0 });
  });

  it('creates a durable execution snapshot and routes a completed node idempotently', () => {
    const base = sample('execution');
    const workflow = versionedWorkflowSchema.parse({
      ...base,
      nodes: [base.nodes[0], { id: 'done', kind: 'validator', validator: 'noop', outcomes: ['passed'] }],
      inputs: [{ name: 'approved', type: 'boolean', required: true }],
      transitions: base.transitions,
    });
    const initial = initializeWorkflowExecution(workflow, 'a'.repeat(64), [], { approved: true });
    expect(initial.ready).toEqual(['work']);
    expect(() => initializeWorkflowExecution(workflow, 'a'.repeat(64), [], {})).toThrow(/required workflow input/);
    expect(() => initializeWorkflowExecution(workflow, 'a'.repeat(64), [], { approved: 'yes' })).toThrow(/must be boolean/);

    const claimed = beginWorkflowNode(initial, 'work');
    expect(claimed.transitionId).toBe(beginWorkflowNode(claimed.execution, 'work').transitionId);
    const advanced = completeWorkflowNode(claimed.execution, 'work', 'passed', { summary: 'reviewed' });
    expect(advanced).toMatchObject({ routedTo: 'done', execution: { outcomes: { work: 'passed' }, outputs: { work: { summary: 'reviewed' } }, ready: ['done'] } });
    expect(completeWorkflowNode(advanced.execution, 'work', 'passed', { summary: 'reviewed' }).execution).toEqual(advanced.execution);
    expect(completeWorkflowNode(advanced.execution, 'work', 'changes_required', {}).error).toMatch(/conflicting results/);
    const terminal = completeWorkflowNode(advanced.execution, 'done', 'passed');
    expect(terminal.execution.status).toBe('done');
  });

  it('retries only the active attempt and routes exhaustion explicitly', () => {
    const base = sample('retry-runtime');
    const workflow = versionedWorkflowSchema.parse({
      ...base,
      nodes: [
        { id: 'work', kind: 'agent', prompt: 'Try {{task}}', outcomes: ['passed', 'investigate', 'exhausted'], retry: { maxAttempts: 2, on: ['investigate'] } },
        { id: 'done', kind: 'validator', validator: 'noop', outcomes: ['passed'] },
      ],
      transitions: [
        { from: 'work', outcome: 'passed', to: 'done', order: 0 },
        { from: 'work', outcome: 'investigate', to: 'done', order: 1 },
        { from: 'work', outcome: 'exhausted', to: 'done', order: 2 },
      ],
    });
    const initial = initializeWorkflowExecution(workflow, 'a'.repeat(64), [], {});
    const first = beginWorkflowNode(initial, 'work');
    const retry = completeWorkflowNode(first.execution, 'work', 'investigate', {}, first.transitionId);
    expect(retry.execution.ready).toEqual(['work']);
    expect(retry.execution.attempts.at(-1)).toMatchObject({ attempt: 2, status: 'pending' });
    expect(completeWorkflowNode(retry.execution, 'work', 'passed', {}, first.transitionId).error).toMatch(/conflicting results/);
    const second = beginWorkflowNode(retry.execution, 'work');
    const exhausted = completeWorkflowNode(second.execution, 'work', 'investigate', {}, second.transitionId);
    expect(exhausted).toMatchObject({ routedTo: 'done', execution: { outcomes: { work: 'exhausted' }, ready: ['done'] } });
  });

  it('rejects a stale or mismatched versioned run pin during recovery checks', () => {
    const workflow = versionedWorkflowSchema.parse(sample('pinned'));
    const digest = createHash('sha256').update(canonicalJson(workflow)).digest('hex');
    const execution = initializeWorkflowExecution(workflow, digest, [], {});
    const pin = { format: 'versioned' as const, id: workflow.id, version: workflow.version, digest, policyPins: [] };
    const record = {
      workflow: `${workflow.id}@${workflow.version}`,
      workflowExecution: execution,
      workflowDefinitionPin: pin,
    } as unknown as RunRecord;
    expect(workflowDefinitionPinMatches(record)).toBe(true);
    expect(workflowDefinitionPinMatches({ ...record, workflowDefinitionPin: { ...pin, digest: 'b'.repeat(64) } })).toBe(false);
    expect(workflowDefinitionPinMatches({ ...record, workflow: 'other@1.0.0' })).toBe(false);
  });

  it('persists and resumes only the declared human, event, or due-time wait', () => {
    const workflow = versionedWorkflowSchema.parse({
      ...sample('waits'), entry: 'approval', terminals: ['approval'], transitions: [],
      nodes: [{ id: 'approval', kind: 'wait', reason: 'external approval', waitFor: 'event', event: 'issue.approved', outcomes: ['passed'] }],
    });
    const execution = initializeWorkflowExecution(workflow, 'a'.repeat(64), [], {});
    expect(execution).toMatchObject({ status: 'waiting', wait: { node: 'approval', reason: 'event', event: 'issue.approved' }, ready: [] });
    expect(resumeWorkflowWait(execution, { kind: 'event', event: 'issue.closed' }).error).toMatch(/does not match/);
    const event = { kind: 'event' as const, event: 'issue.approved', eventId: 'delivery-123' };
    const resumed = resumeWorkflowWait(execution, event);
    expect(resumed.execution).toMatchObject({ status: 'done', eventReceipts: [{ eventId: 'delivery-123', event: 'issue.approved', node: 'approval' }] });
    expect(resumeWorkflowWait(resumed.execution, event).execution).toEqual(resumed.execution);
    expect(resumeWorkflowWait(resumed.execution, { ...event, event: 'issue.closed' }).error).toMatch(/different event name/);
    expect(versionedWorkflowEventInputSchema.safeParse({ event: event.event, eventId: event.eventId }).success).toBe(true);
    expect(versionedWorkflowEventInputSchema.safeParse({ event: 'issue.approved' }).success).toBe(false);
    expect(versionedWorkflowSchema.safeParse({
      ...workflow, nodes: [{ id: 'approval', kind: 'wait', reason: 'timer', waitFor: 'time', outcomes: ['passed'] }],
    }).success).toBe(false);
    const timerWorkflow = versionedWorkflowSchema.parse({
      ...workflow, nodes: [{ id: 'approval', kind: 'wait', reason: 'timer', waitFor: 'time', resumeAt: '2026-11-21T12:00:00.000Z', outcomes: ['passed'] }],
    });
    const timer = initializeWorkflowExecution(timerWorkflow, 'a'.repeat(64), [], {});
    expect(resumeWorkflowWait(timer, { kind: 'time', now: '2026-11-21T11:59:59.000Z' }).error).toMatch(/not due/);
    expect(resumeWorkflowWait(timer, { kind: 'time', now: '2026-11-21T12:00:00.000Z' }).execution.status).toBe('done');
  });

  it('fails terminal graphs whose result is blocked or unknown instead of reporting completion', () => {
    const workflow = versionedWorkflowSchema.parse({
      ...sample('terminal-outcome', 'policy_gate'), entry: 'gate', terminals: ['gate'], transitions: [],
      nodes: [{ id: 'gate', kind: 'policy_gate', policy: 'review-required', outcomes: ['passed', 'blocked'] }],
    });
    const initial = initializeWorkflowExecution(workflow, 'a'.repeat(64), [], {});
    const running = beginWorkflowNode(initial, 'gate').execution;
    expect(completeWorkflowNode(running, 'gate', 'blocked').execution.status).toBe('failed');
  });

  it('preserves typed terminal outcomes while keeping unknown results fail-closed', () => {
    const workflow = versionedWorkflowSchema.parse({
      ...sample('typed-terminal', 'policy_gate'), entry: 'gate', terminals: ['gate'], transitions: [],
      nodes: [{ id: 'gate', kind: 'policy_gate', policy: 'lifecycle-result', outcomes: ['ready', 'unknown'] }],
    });
    const initial = initializeWorkflowExecution(workflow, 'a'.repeat(64), [], {});
    const running = beginWorkflowNode(initial, 'gate').execution;
    expect(completeWorkflowNode(running, 'gate', 'ready').execution).toMatchObject({ status: 'done', outcomes: { gate: 'ready' } });
    expect(completeWorkflowNode(running, 'gate', 'unknown').execution).toMatchObject({ status: 'failed', outcomes: { gate: 'unknown' } });
  });

  it('keeps legacy YAML normalization behavior intact', () => {
    const legacy = workflowFileSchema.parse({ name: 'legacy', skills: ['plan', 'implement'] });
    expect(normalizeWorkflowDoc(legacy).steps.map((step) => step.id)).toEqual(['plan', 'implement']);
    expect(normalizeWorkflowDoc(legacy).steps.map((step) => step.prompt)).toEqual(['{{task}}', '{{task}}']);
  });
});
