import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, evaluateGuard, versionedWorkflowSchema } from '@open-mercato/cezar-contract';
import { normalizeWorkflowDoc, workflowFileSchema } from './types.ts';

function sample(id: string, kind: 'agent' | 'validator' | 'policy_gate' | 'action' = 'agent') {
  const node = kind === 'agent' ? { id: 'work', kind, prompt: 'Complete {{task}}', outcomes: ['passed', 'changes_required', 'needs_input'] }
    : kind === 'validator' ? { id: 'work', kind, validator: 'local-suite', outcomes: ['passed', 'investigate'] }
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
    for (const value of [sample('issue-delivery', 'action'), sample('investigation', 'agent'), sample('review', 'policy_gate'), sample('repair', 'validator')]) {
      expect(versionedWorkflowSchema.safeParse(value).success).toBe(true);
    }
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
  });

  it('canonicalizes property order and fails closed for missing guard values', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
    expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
    expect(evaluateGuard({ op: 'input_equals', path: 'decision.approved', value: true }, { outcomes: {}, inputs: {} })).toBe('unknown');
    expect(evaluateGuard({ op: 'outcome_is', node: 'missing', outcome: 'passed' }, { outcomes: {}, inputs: {} })).toBe('unknown');
  });

  it('keeps legacy YAML normalization behavior intact', () => {
    const legacy = workflowFileSchema.parse({ name: 'legacy', skills: ['plan', 'implement'] });
    expect(normalizeWorkflowDoc(legacy).steps.map((step) => step.id)).toEqual(['plan', 'implement']);
    expect(normalizeWorkflowDoc(legacy).steps.map((step) => step.prompt)).toEqual(['{{task}}', '{{task}}']);
  });
});
