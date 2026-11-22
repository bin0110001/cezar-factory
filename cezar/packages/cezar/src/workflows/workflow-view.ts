import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import {
  canonicalJson, workflowDefinitionViewSchema, workflowExecutionViewSchema,
  versionedWorkflowCatalogSchema, type VersionedWorkflow, type WorkflowExecution,
  type WorkflowExecutionView,
} from '@open-mercato/cezar-contract';
import { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';
import type { RunRecord } from '../runs/store.ts';

function safeText(value: string, max = 300): string {
  return redactSecrets(value, collectSecretValues())
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>]+/g, '[host path]')
    .replace(/(^|[\s("'=])\/(?:home|var|tmp|projects|Users|workspace)\/[^\s"'<>]+/g, '$1[host path]')
    .slice(0, max);
}

function guardLabel(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const guard = value as Record<string, unknown>;
  if (guard.op === 'all' || guard.op === 'any') {
    const entries = Array.isArray(guard.guards) ? guard.guards.map(guardLabel).filter(Boolean) : [];
    return `${guard.op === 'all' ? 'all' : 'any'}: ${entries.join('; ')}`.slice(0, 500);
  }
  if (guard.op === 'outcome_is' && typeof guard.node === 'string' && typeof guard.outcome === 'string') {
    return `${safeText(guard.node, 48)} outcome is ${safeText(guard.outcome, 48)}`;
  }
  if (guard.op === 'input_equals' && typeof guard.path === 'string') return `${safeText(guard.path, 128)} equals configured value`;
  return 'configured guard';
}

function nodeDetail(node: VersionedWorkflow['nodes'][number]): string | undefined {
  switch (node.kind) {
    case 'agent': return node.dispatchKind === 'review' ? 'Independent review session' : `Agent session: ${node.session}`;
    case 'verification': return `Suite: ${safeText(node.suite, 128)}`;
    case 'action': return `Action: ${safeText(node.action, 128)}`;
    case 'validator': return `Validator: ${safeText(node.validator, 128)}`;
    case 'policy_gate': return `Policy: ${safeText(node.policy, 128)}`;
    case 'wait': return `${node.waitFor}: ${safeText(node.reason, 220)}`;
    case 'child_workflow': return `Nested workflow: ${safeText(node.workflow, 64)}@${node.version}`;
    case 'fork': return `${node.children.length} parallel child runs`;
    case 'join': return `Joins ${safeText(node.fork, 48)}`;
    case 'return': return `Returns ${safeText(node.source, 48)}`;
  }
}

export function workflowDefinitionView(workflow: VersionedWorkflow) {
  return workflowDefinitionViewSchema.parse({
    id: workflow.id,
    version: workflow.version,
    digest: createHash('sha256').update(canonicalJson(workflow)).digest('hex'),
    entry: workflow.entry,
    terminals: workflow.terminals,
    compatibility: workflow.compatibility,
    budget: workflow.budget,
    policyRefs: workflow.policyRefs.map((pin) => `${safeText(pin.id, 128)}@${safeText(pin.version, 64)}`),
    nodes: workflow.nodes.map((node) => ({
      id: safeText(node.id, 48), kind: node.kind, outcomes: node.outcomes,
      session: node.session,
      ...(node.retry ? { retry: node.retry } : {}),
      ...(node.timeoutSeconds ? { timeoutSeconds: node.timeoutSeconds } : {}),
      inputs: node.inputs.map(({ name, type }) => ({ name: safeText(name, 128), type })),
      outputs: node.outputs.map(({ name, type }) => ({ name: safeText(name, 128), type })),
      ...(nodeDetail(node) ? { detail: nodeDetail(node) } : {}),
    })),
    transitions: workflow.transitions.map((transition) => ({
      from: safeText(transition.from, 48), outcome: transition.outcome,
      to: safeText(transition.to, 48), order: transition.order,
      ...(transition.when ? { guardLabel: guardLabel(transition.when) } : {}),
    })),
  });
}

export function versionedWorkflowCatalogView(input: {
  workflows: VersionedWorkflow[];
  issues: Array<{ path: string; message: string }>;
}) {
  return versionedWorkflowCatalogSchema.parse({
    workflows: input.workflows.map(workflowDefinitionView),
    issues: input.issues.map((issue) => ({ path: basename(issue.path), message: safeText(issue.message, 500) })),
  });
}

function safeRelativePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.startsWith('/') || /^[A-Za-z]:/.test(value)
      || value.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')) return undefined;
  return safeText(value.replace(/\\/g, '/'), 1024);
}

function safeFinding(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const finding = value as Record<string, unknown>;
  if (finding.path !== undefined && !safeRelativePath(finding.path)) return undefined;
  const text = (candidate: unknown, max = 300) => typeof candidate === 'string' ? safeText(candidate, max) : undefined;
  const line = typeof finding.line === 'number' && Number.isSafeInteger(finding.line) && finding.line > 0 ? finding.line : undefined;
  const fingerprint = typeof finding.fingerprint === 'string' && /^[a-f0-9]{64}$/i.test(finding.fingerprint) ? finding.fingerprint : undefined;
  return {
    ...(text(finding.id, 128) ? { id: text(finding.id, 128) } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    ...(text(finding.title ?? finding.message, 600) ? { title: text(finding.title ?? finding.message, 600) } : {}),
    ...(safeRelativePath(finding.path) ? { path: safeRelativePath(finding.path) } : {}),
    ...(line ? { line } : {}),
    ...(text(finding.severity, 32) ? { severity: text(finding.severity, 32) } : {}),
    ...(text(finding.confidence, 32) ? { confidence: text(finding.confidence, 32) } : {}),
    ...(text(finding.provenance, 128) ? { provenance: text(finding.provenance, 128) } : {}),
    ...(text(finding.reviewerSessionId, 128) ? { reviewerSessionId: text(finding.reviewerSessionId, 128) } : {}),
    ...(text((finding.aiAudit as Record<string, unknown> | undefined)?.state ?? finding.verificationState, 64)
      ? { verificationState: text((finding.aiAudit as Record<string, unknown> | undefined)?.state ?? finding.verificationState, 64) } : {}),
  };
}

function safeAttemptOutputs(value: Record<string, unknown> | undefined) {
  if (!value) return undefined;
  const str = (key: string, max = 128) => typeof value[key] === 'string' ? safeText(value[key] as string, max) : undefined;
  const sha = (key: string) => typeof value[key] === 'string' && /^[a-f0-9]{40,64}$/i.test(value[key] as string) ? value[key] : undefined;
  const findings = Array.isArray(value.findings) ? value.findings.map(safeFinding).filter((item): item is NonNullable<typeof item> => Boolean(item)).slice(0, 24) : undefined;
  const result = {
    ...(str('status', 32) ? { status: str('status', 32) } : {}),
    ...(sha('commitSha') ? { commitSha: sha('commitSha') } : {}),
    ...(str('artifactRevision', 71) ? { artifactRevision: str('artifactRevision', 71) } : {}),
    ...(str('verificationId', 128) ? { verificationId: str('verificationId', 128) } : {}),
    ...(findings ? { findings } : {}),
  };
  return Object.keys(result).length ? result : undefined;
}

export function workflowExecutionView(input: {
  run: Pick<RunRecord, 'id' | 'workflowExecution'>;
  runs: readonly RunRecord[];
}): WorkflowExecutionView | undefined {
  const execution = input.run.workflowExecution as WorkflowExecution | undefined;
  if (!execution) return undefined;
  const childRuns = new Map(input.runs.filter((run) => run.dispatch?.parentRunId === input.run.id).map((run) => [run.id, run]));
  const childIds = [...new Set(execution.attempts.map((attempt) => attempt.childRunId).filter((id): id is string => Boolean(id)))].slice(0, 100);
  return workflowExecutionViewSchema.parse({
    runId: input.run.id,
    status: execution.status,
    workflow: workflowDefinitionView(execution.workflow),
    definitionDigest: execution.definitionDigest,
    policyPins: execution.policyPins,
    outcomes: execution.outcomes,
    ready: execution.ready,
    ...(execution.wait ? { wait: {
      node: execution.wait.node, reason: execution.wait.reason,
      ...(execution.wait.detail ? { detail: safeText(execution.wait.detail, 500) } : {}),
      ...(execution.wait.resumeAt ? { resumeAt: execution.wait.resumeAt } : {}),
    } } : {}),
    attempts: execution.attempts.slice(-1000).map((attempt) => ({
      node: attempt.node, attempt: attempt.attempt, status: attempt.status, startedAt: attempt.startedAt,
      ...(attempt.finishedAt ? { finishedAt: attempt.finishedAt } : {}),
      ...(attempt.outcome ? { outcome: attempt.outcome } : {}),
      ...(attempt.childRunId ? { childRunId: attempt.childRunId } : {}),
      errorPresent: Boolean(attempt.error),
      ...(attempt.effectReceipt ? { effectStatus: attempt.effectReceipt.status } : {}),
      ...(safeAttemptOutputs(attempt.outputs) ? { outputs: safeAttemptOutputs(attempt.outputs) } : {}),
    })),
    children: childIds.flatMap((id) => {
      const child = childRuns.get(id);
      if (!child) return [];
      return [{ id, status: child.status, ...(child.dispatch?.kind ? { dispatchKind: child.dispatch.kind } : {}),
        ...(child.workflowExecution ? { workflow: workflowDefinitionView(child.workflowExecution.workflow) } : {}) }];
    }),
    githubApproval: 'not-in-workflow-record',
  });
}
