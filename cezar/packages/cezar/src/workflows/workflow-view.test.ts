import { afterEach, describe, expect, it } from 'vitest';
import { initializeWorkflowExecution, versionedWorkflowSchema } from '@open-mercato/cezar-contract';
import type { RunRecord } from '../runs/store.ts';
import { versionedWorkflowCatalogView, workflowDefinitionView, workflowExecutionView } from './workflow-view.ts';

const digest = 'a'.repeat(64);
const workflow = (id = 'factory.review-view') => versionedWorkflowSchema.parse({
  contract: 'cezar.workflow', schemaVersion: 1, id, version: '1.0.0', entry: 'implement', terminals: ['review'],
  inputs: [], policyRefs: [{ id: 'review-policy', version: '1', digest }],
  nodes: [
    { id: 'implement', kind: 'agent', session: 'continue', dispatchKind: 'implement', prompt: 'do the work with secret ghp_abcdefghijklmnopqrstuvwxyz123456', outcomes: ['passed'] },
    { id: 'verify', kind: 'verification', suite: 'full', outcomes: ['passed', 'unknown', 'interrupted'] },
    { id: 'repair', kind: 'agent', session: 'continue', dispatchKind: 'implement', prompt: 'repair it', outcomes: ['passed'] },
    { id: 'review', kind: 'agent', session: 'new', dispatchKind: 'review', prompt: 'review it', outcomes: ['passed', 'changes_required'] },
  ],
  transitions: [
    { from: 'implement', outcome: 'passed', to: 'verify', order: 0, when: { op: 'input_equals', path: 'mode', value: 'secret-value' } },
    { from: 'verify', outcome: 'passed', to: 'review', order: 0 },
    { from: 'verify', outcome: 'unknown', to: 'repair', order: 1 },
    { from: 'verify', outcome: 'interrupted', to: 'repair', order: 2 },
    { from: 'repair', outcome: 'passed', to: 'review', order: 0 },
  ],
  budget: { maxAttempts: 8 }, capabilities: [],
  compatibility: { mode: 'versioned-only', minConsumer: '0.14.0', maxConsumer: '0.14.99' },
});

describe('workflow operator views', () => {
  const previousToken = process.env.OPENAI_API_KEY;
  afterEach(() => {
    if (previousToken === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousToken;
  });

  it('summarizes native definitions without exposing prompts or guard literals', () => {
    const view = workflowDefinitionView(workflow());
    expect(view.nodes.map((node) => node.detail)).toContain('Independent review session');
    expect(view.transitions[0]?.guardLabel).toBe('mode equals configured value');
    expect(JSON.stringify(view)).not.toContain('ghp_');
    expect(JSON.stringify(view)).not.toContain('secret-value');
    expect(JSON.stringify(view)).not.toContain('do the work');
    expect(view.policyRefs).toEqual(['review-policy@1']);
  });

  it('hides host paths and secrets from catalog errors', () => {
    const view = versionedWorkflowCatalogView({
      workflows: [],
      issues: [{ path: 'C:\\private\\src\\broken.workflow.json', message: 'bad credential ghp_abcdefghijklmnopqrstuvwxyz123456 in C:\\private\\src\\broken.workflow.json' }],
    });
    expect(view.issues[0]?.path).toBe('broken.workflow.json');
    expect(JSON.stringify(view)).not.toContain('C:\\private');
    expect(JSON.stringify(view)).not.toContain('ghp_');
  });

  it('shows attempts and revision-bound review evidence while keeping GitHub approval distinct', () => {
    process.env.OPENAI_API_KEY = 'workflow-view-secret-value';
    const definition = workflow();
    const initialized = initializeWorkflowExecution(definition, digest, definition.policyRefs, {});
    const execution = {
      ...initialized,
      outcomes: { implement: 'passed', verify: 'changes_required', repair: 'passed', review: 'passed' },
      attempts: [
        { node: 'implement', attempt: 1, transitionId: 'i1', childRunId: 'impl-run', status: 'done', startedAt: '2026-01-01T00:00:00Z', outcome: 'passed', outputs: { status: 'passed', commitSha: 'b'.repeat(40) } },
        { node: 'verify', attempt: 1, transitionId: 'v1', status: 'done', startedAt: '2026-01-01T00:00:01Z', outcome: 'changes_required', outputs: { status: 'failed', commitSha: 'b'.repeat(40), artifactRevision: 'sha256:' + 'c'.repeat(64), findings: [{ fingerprint: digest, title: 'review token workflow-view-secret-value', path: 'src/file.ts', line: 8, confidence: 'unknown', reviewerSessionId: 'ocr-session' }, { title: 'unsafe path', path: 'C:\\private\\file.ts' }] } },
        { node: 'repair', attempt: 1, transitionId: 'r1', childRunId: 'impl-run', status: 'done', startedAt: '2026-01-01T00:00:02Z', outcome: 'passed' },
      ],
    };
    const child = { id: 'impl-run', status: 'done', dispatch: { parentRunId: 'root-run', kind: 'implement' } } as unknown as RunRecord;
    const view = workflowExecutionView({
      run: { id: 'root-run', workflowExecution: execution } as unknown as RunRecord,
      runs: [child],
    })!;
    expect(view.attempts.map(({ node, attempt }) => `${node}:${attempt}`)).toEqual(['implement:1', 'verify:1', 'repair:1']);
    expect(view.children).toEqual([{ id: 'impl-run', status: 'done', dispatchKind: 'implement' }]);
    expect(view.attempts[1]?.outputs?.findings?.[0]).toMatchObject({ path: 'src/file.ts', confidence: 'unknown', reviewerSessionId: 'ocr-session' });
    expect(view.attempts[1]?.outputs?.findings).toHaveLength(1);
    expect(view.githubApproval).toBe('not-in-workflow-record');
    expect(JSON.stringify(view)).not.toContain('workflow-view-secret-value');
    expect(JSON.stringify(view)).not.toContain('C:\\private');
    expect(JSON.stringify(view)).not.toContain('raw output');
  });
});
