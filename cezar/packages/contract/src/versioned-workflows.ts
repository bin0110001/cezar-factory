import { z } from 'zod';

/** Declarative graph contract v1. This is additive; workflowDefSchema remains the legacy adapter. */
export const workflowOutcomeSchema = z.enum([
  'passed', 'changes_required', 'needs_input', 'investigate', 'blocked', 'skipped',
  'unknown', 'interrupted', 'exhausted',
]);
export type WorkflowOutcome = z.infer<typeof workflowOutcomeSchema>;

export const workflowEffectReceiptDataSchema = z.object({
  system: z.string().min(1).max(100),
  resource: z.string().min(1).max(300),
  operation: z.string().min(1).max(100),
  receiptId: z.string().min(1).max(300),
  revision: z.string().max(300).optional(),
}).strict();

export const versionedWorkflowEventInputSchema = z.object({
  event: z.string().min(1).max(200),
  eventId: z.string().min(1).max(200),
}).strict();

const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const portSchema = z.object({ name: z.string().min(1), type: z.enum(['string', 'number', 'boolean', 'object', 'array']), required: z.boolean().default(false) }).strict();
const budgetSchema = z.object({ maxAttempts: z.number().int().positive().optional(), maxDurationSeconds: z.number().int().positive().optional(), maxTokens: z.number().int().positive().optional() }).strict();
const guardAtomSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('outcome_is'), node: z.string().min(1), outcome: workflowOutcomeSchema }).strict(),
  z.object({ op: z.literal('input_equals'), path: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*$/), value: scalarSchema }).strict(),
]);
const guardSchema = z.union([
  guardAtomSchema,
  z.object({ op: z.literal('all'), guards: z.array(guardAtomSchema).min(1) }).strict(),
  z.object({ op: z.literal('any'), guards: z.array(guardAtomSchema).min(1) }).strict(),
]);

const nodeBase = z.object({ id: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*$/).max(48), inputs: z.array(portSchema).default([]), outputs: z.array(portSchema).default([]), timeoutSeconds: z.number().int().positive().max(86400).optional(), retry: z.object({ maxAttempts: z.number().int().positive(), on: z.array(workflowOutcomeSchema).min(1) }).strict().optional(), compensation: z.string().min(1).optional(), resources: z.array(z.string().min(1)).default([]), session: z.enum(['continue', 'new', 'none', 'external', 'inherit']).default('continue') });
export const workflowNodeSchema = z.discriminatedUnion('kind', [
  nodeBase.extend({ kind: z.literal('action'), action: z.string().min(1), capabilities: z.array(z.string().min(1)).default([]), outcomes: z.array(workflowOutcomeSchema).min(1) }),
  nodeBase.extend({ kind: z.literal('agent'), prompt: z.string().min(1), skill: z.string().optional(), dispatchKind: z.enum(['implement', 'review']).default('implement'), outcomes: z.array(workflowOutcomeSchema).min(1) }),
  nodeBase.extend({ kind: z.literal('validator'), validator: z.string().min(1), outcomes: z.array(workflowOutcomeSchema).min(1) }),
  nodeBase.extend({ kind: z.literal('policy_gate'), policy: z.string().min(1), outcomes: z.array(workflowOutcomeSchema).min(1) }),
  nodeBase.extend({
    kind: z.literal('wait'), reason: z.string().min(1), waitFor: z.enum(['human', 'event', 'time']).default('human'),
    event: z.string().min(1).optional(), resumeAt: z.string().datetime().optional(), outcomes: z.array(workflowOutcomeSchema).length(1).default(['passed']),
  }).superRefine((node, ctx) => {
    if (node.waitFor === 'event' && !node.event) ctx.addIssue({ code: 'custom', path: ['event'], message: 'event waits require an event name' });
    if (node.waitFor !== 'event' && node.event) ctx.addIssue({ code: 'custom', path: ['event'], message: 'event is only valid for event waits' });
    if (node.waitFor === 'time' && !node.resumeAt) ctx.addIssue({ code: 'custom', path: ['resumeAt'], message: 'time waits require a resumeAt instant' });
    if (node.waitFor !== 'time' && node.resumeAt) ctx.addIssue({ code: 'custom', path: ['resumeAt'], message: 'resumeAt is only valid for time waits' });
  }),
  nodeBase.extend({ kind: z.literal('child_workflow'), workflow: z.string().min(1), version: z.string().regex(/^\d+\.\d+\.\d+$/), outcomes: z.array(workflowOutcomeSchema).min(1) }),
  nodeBase.extend({ kind: z.literal('fork'), children: z.array(z.string().min(1)).min(1).max(32), join: z.discriminatedUnion('mode', [z.object({ mode: z.literal('all'), cancel: z.literal('on_terminal').default('on_terminal') }).strict(), z.object({ mode: z.literal('any'), cancel: z.literal('on_terminal').default('on_terminal') }).strict(), z.object({ mode: z.literal('quorum'), count: z.number().int().positive(), cancel: z.literal('on_terminal').default('on_terminal') }).strict()]), outcomes: z.array(workflowOutcomeSchema).min(1) }),
  nodeBase.extend({ kind: z.literal('join'), fork: z.string().min(1), outcomes: z.array(workflowOutcomeSchema).min(1) }),
]);

export const versionedWorkflowSchema = z.object({
  contract: z.literal('cezar.workflow'), schemaVersion: z.literal(1), id: z.string().regex(/^[a-z][a-z0-9.-]+$/).max(48), version: z.string().regex(/^\d+\.\d+\.\d+$/).max(20), description: z.string().optional(),
  entry: z.string().min(1).max(48), terminals: z.array(z.string().min(1).max(48)).min(1), inputs: z.array(portSchema).default([]), nodes: z.array(workflowNodeSchema).min(1),
  transitions: z.array(z.object({ from: z.string().min(1).max(48), outcome: workflowOutcomeSchema, to: z.string().min(1).max(48), when: guardSchema.optional(), order: z.number().int().nonnegative().max(9_999_999) }).strict()),
  budget: budgetSchema.default({}), policyRefs: z.array(z.object({ id: z.string().min(1), version: z.string().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).default([]),
  capabilities: z.array(z.string().min(1)).default([]), compatibility: z.object({ mode: z.enum(['legacy-adapter', 'versioned-only']), minConsumer: z.string().regex(/^\d+\.\d+\.\d+$/), maxConsumer: z.string().regex(/^\d+\.\d+\.\d+$/) }).strict(),
}).strict().superRefine((workflow, ctx) => {
  const ids = workflow.nodes.map((node) => node.id);
  const known = new Set(ids);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['nodes'], message: 'node ids must be unique' });
  if (!known.has(workflow.entry)) ctx.addIssue({ code: 'custom', path: ['entry'], message: 'entry must reference a node' });
  for (const terminal of workflow.terminals) if (!known.has(terminal)) ctx.addIssue({ code: 'custom', path: ['terminals'], message: `terminal references unknown node "${terminal}"` });
  const terminalSet = new Set(workflow.terminals);
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  for (const node of workflow.nodes) {
    if (node.kind === 'fork' && node.join.mode === 'quorum' && node.join.count > node.children.length) ctx.addIssue({ code: 'custom', path: ['nodes', node.id, 'join', 'count'], message: 'quorum cannot exceed fanout' });
    if (node.kind === 'fork') for (const child of node.children) {
      if (!known.has(child)) ctx.addIssue({ code: 'custom', path: ['nodes', node.id, 'children'], message: `fork references unknown node "${child}"` });
      const childNode = nodeById.get(child);
      if (childNode && childNode.kind !== 'agent') ctx.addIssue({ code: 'custom', path: ['nodes', node.id, 'children'], message: `fork child "${child}" must be an agent node with a registered worker` });
      if (childNode?.kind === 'agent' && childNode.session !== 'new') ctx.addIssue({ code: 'custom', path: ['nodes', node.id, 'children'], message: `fork child "${child}" must use a distinct new session` });
    }
    if (node.kind === 'action') for (const capability of node.capabilities) if (!workflow.capabilities.includes(capability)) ctx.addIssue({ code: 'custom', path: ['nodes', node.id, 'capabilities'], message: `unsupported node capability "${capability}"` });
    if (node.session === 'external' && !workflow.capabilities.includes('session.external')) ctx.addIssue({ code: 'custom', path: ['nodes', node.id, 'session'], message: 'external session ownership requires the session.external capability' });
    if (node.kind === 'agent' && node.session === 'none') ctx.addIssue({ code: 'custom', path: ['nodes', node.id, 'session'], message: 'agent nodes require an owned or external session' });
    if (node.kind === 'agent' && node.dispatchKind === 'review' && node.session !== 'new') ctx.addIssue({ code: 'custom', path: ['nodes', node.id, 'session'], message: 'review nodes require a distinct new session' });
    if (node.retry && !node.outcomes.includes('exhausted')) ctx.addIssue({ code: 'custom', path: ['nodes', node.id, 'outcomes'], message: 'retryable nodes must declare an exhausted outcome' });
    if (node.kind === 'join' && !workflow.nodes.some((candidate) => candidate.kind === 'fork' && candidate.id === node.fork)) ctx.addIssue({ code: 'custom', path: ['nodes', node.id, 'fork'], message: 'join must reference a fork node' });
  }
  for (const [i, transition] of workflow.transitions.entries()) {
    if (!known.has(transition.from) || !known.has(transition.to)) ctx.addIssue({ code: 'custom', path: ['transitions', i], message: 'transition references unknown node' });
    if (terminalSet.has(transition.from)) ctx.addIssue({ code: 'custom', path: ['transitions', i, 'from'], message: 'terminal nodes cannot have outgoing transitions' });
    const source = nodeById.get(transition.from);
    if (source && !source.outcomes.includes(transition.outcome)) ctx.addIssue({ code: 'custom', path: ['transitions', i, 'outcome'], message: 'transition outcome is not declared by its source node' });
    const atoms = transition.when && 'guards' in transition.when ? transition.when.guards : transition.when ? [transition.when] : [];
    for (const atom of atoms) if (atom.op === 'outcome_is' && !known.has(atom.node)) ctx.addIssue({ code: 'custom', path: ['transitions', i, 'when'], message: 'guard references unknown node' });
  }
  const orderKeys = workflow.transitions.map((transition) => `${transition.from}\0${transition.order}`);
  if (new Set(orderKeys).size !== orderKeys.length) ctx.addIssue({ code: 'custom', path: ['transitions'], message: 'transition order must be unique per source node' });
  for (const node of workflow.nodes) {
    const outcomes = new Set(node.outcomes);
    for (const outcome of outcomes) if (!workflow.transitions.some((transition) => transition.from === node.id && transition.outcome === outcome)) {
      if (!terminalSet.has(node.id)) ctx.addIssue({ code: 'custom', path: ['transitions'], message: `node "${node.id}" outcome "${outcome}" has no transition` });
    }
  }
});
export type VersionedWorkflow = z.infer<typeof versionedWorkflowSchema>;

export const workflowJsonValueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

/** Durable coordinator snapshot stored on the existing run record. Attempts are append-only
 * logical node invocations; references point at existing run/event/evidence records. */
export const workflowExecutionSchema = z.object({
  workflow: versionedWorkflowSchema,
  definitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  policyPins: z.array(z.object({ id: z.string(), version: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
  // Values are checked against declared ports at ingress. `any` here is intentional: node
  // ports permit arrays and objects, while a recursive public Zod output type exceeds TS's
  // inference depth in the run route contract.
  inputs: z.record(z.string(), z.any()),
  outcomes: z.record(z.string(), workflowOutcomeSchema),
  outputs: z.record(z.string(), z.record(z.string(), z.any())),
  attempts: z.array(z.object({ node: z.string(), attempt: z.number().int().positive(), transitionId: z.string(), childRunId: z.string().optional(), status: z.enum(['pending', 'running', 'waiting', 'done', 'failed', 'cancelled']), startedAt: z.string(), timeoutAt: z.string().optional(), finishedAt: z.string().optional(), outcome: workflowOutcomeSchema.optional(), outputs: z.record(z.string(), z.any()).optional(), error: z.string().optional(), effectReceipt: z.object({ action: z.string(), idempotencyKey: z.string().regex(/^[a-f0-9]{64}$/), status: z.enum(['pending', 'confirmed', 'unknown']), startedAt: z.string(), settledAt: z.string().optional(), receipt: workflowEffectReceiptDataSchema.optional(), outcome: workflowOutcomeSchema.optional(), outputs: z.record(z.string(), z.any()).optional() }).strict().optional() }).strict()),
  ready: z.array(z.string()),
  wait: z.object({ node: z.string(), reason: z.enum(['human', 'event', 'time']), detail: z.string().optional(), resumeAt: z.string().optional(), event: z.string().optional() }).strict().optional(),
  eventReceipts: z.array(z.object({ eventId: z.string(), event: z.string(), node: z.string(), receivedAt: z.string() }).strict()).max(10000).default([]),
  status: z.enum(['running', 'waiting', 'done', 'failed', 'cancelled']),
}).strict();
export type WorkflowExecution = z.infer<typeof workflowExecutionSchema>;

function portValueMatches(type: 'string' | 'number' | 'boolean' | 'object' | 'array', value: unknown): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
  }
}

export function validateWorkflowNodeOutputs(node: VersionedWorkflow['nodes'][number], outputs: Record<string, unknown>): string | undefined {
  for (const port of node.outputs) {
    if (port.required && outputs[port.name] === undefined) return `required output "${port.name}" is missing from node "${node.id}"`;
    if (outputs[port.name] !== undefined && !portValueMatches(port.type, outputs[port.name])) return `output "${port.name}" from node "${node.id}" must be ${port.type}`;
  }
  return undefined;
}

/** Create the first durable graph snapshot. Reject missing and mistyped declared inputs. */
export function initializeWorkflowExecution(
  workflow: VersionedWorkflow,
  definitionDigest: string,
  policyPins: WorkflowExecution['policyPins'],
  inputs: Record<string, unknown>,
): WorkflowExecution {
  for (const port of workflow.inputs) {
    const value = inputs[port.name];
    if (port.required && value === undefined) throw new Error(`required workflow input "${port.name}" is missing`);
    if (value !== undefined && !portValueMatches(port.type, value)) throw new Error(`workflow input "${port.name}" must be ${port.type}`);
  }
  const entry = workflow.nodes.find((node) => node.id === workflow.entry)!;
  const waiting = entry.kind === 'wait';
  const startedAt = new Date().toISOString();
  const attempt = { node: workflow.entry, attempt: 1, transitionId: `${workflow.entry}:1`, status: waiting ? 'waiting' as const : 'pending' as const, startedAt,
    ...(entry.timeoutSeconds ? { timeoutAt: new Date(Date.parse(startedAt) + entry.timeoutSeconds * 1000).toISOString() } : {}) };
  return workflowExecutionSchema.parse({ workflow, definitionDigest, policyPins, inputs, outcomes: {}, outputs: {}, attempts: [attempt], ready: waiting ? [] : [workflow.entry], eventReceipts: [], ...(waiting ? { wait: { node: entry.id, reason: entry.waitFor, detail: entry.reason, ...(entry.event ? { event: entry.event } : {}), ...(entry.resumeAt ? { resumeAt: entry.resumeAt } : {}) } } : {}), status: waiting ? 'waiting' : 'running' });
}

/** Claim a ready attempt before invoking its worker. Replayed claims preserve the same attempt. */
export function beginWorkflowNode(execution: WorkflowExecution, nodeId: string): { execution: WorkflowExecution; transitionId?: string; error?: string } {
  const attempt = [...execution.attempts].reverse().find((candidate) => candidate.node === nodeId);
  if (!attempt) return { execution, error: `node "${nodeId}" has no recorded attempt` };
  if (attempt.status === 'running') return { execution, transitionId: attempt.transitionId };
  if (attempt.status !== 'pending' || !execution.ready.includes(nodeId)) return { execution, error: `node "${nodeId}" is not ready to start` };
  const node = execution.workflow.nodes.find((candidate) => candidate.id === nodeId)!;
  const startedAt = new Date().toISOString();
  const attempts = execution.attempts.map((candidate) => candidate.transitionId === attempt.transitionId ? {
    ...candidate, status: 'running' as const, startedAt,
    ...(node.timeoutSeconds ? { timeoutAt: new Date(Date.parse(startedAt) + node.timeoutSeconds * 1000).toISOString() } : {}),
  } : candidate);
  return { execution: workflowExecutionSchema.parse({ ...execution, attempts, ready: execution.ready.filter((id) => id !== nodeId) }), transitionId: attempt.transitionId };
}

/** Resolve only the specific persisted wait that was declared by the current node. */
export function resumeWorkflowWait(
  execution: WorkflowExecution,
  trigger: { kind: 'human' } | { kind: 'event'; event: string; eventId?: string } | { kind: 'time'; now?: string },
): { execution: WorkflowExecution; routedTo?: string; error?: string } {
  if (trigger.kind === 'event' && trigger.eventId) {
    const duplicate = execution.eventReceipts.find((receipt) => receipt.eventId === trigger.eventId);
    if (duplicate) return duplicate.event === trigger.event ? { execution } : { execution: { ...execution, status: 'failed' }, error: `event id "${trigger.eventId}" was replayed with a different event name` };
    if (execution.eventReceipts.length >= 10000) return { execution, error: 'workflow event receipt limit reached' };
  }
  const wait = execution.wait;
  if (!wait || execution.status !== 'waiting') return { execution, error: 'workflow has no outstanding wait' };
  if (trigger.kind !== wait.reason || (trigger.kind === 'event' && trigger.event !== wait.event)) return { execution, error: 'resume trigger does not match the persisted wait' };
  if (trigger.kind === 'time' && (!wait.resumeAt || Date.parse(wait.resumeAt) > Date.parse(trigger.now ?? new Date().toISOString()))) return { execution, error: 'time wait is not due yet' };
  const waitAttempt = [...execution.attempts].reverse().find((attempt) => attempt.node === wait.node && attempt.status === 'waiting');
  const result = completeWorkflowNode(execution, wait.node, 'passed', {}, waitAttempt?.transitionId);
  if (result.error) return result;
  return {
    ...result,
    execution: workflowExecutionSchema.parse({
      ...result.execution,
      wait: undefined,
      ...(trigger.kind === 'event' && trigger.eventId ? {
        eventReceipts: [...execution.eventReceipts, { eventId: trigger.eventId, event: trigger.event, node: wait.node, receivedAt: new Date().toISOString() }],
      } : {}),
    }),
  };
}

/**
 * Persist one node result and its deterministic successor in the same snapshot. Replayed
 * completion is idempotent when its payload agrees; conflicting completion fails closed.
 */
export function completeWorkflowNode(
  execution: WorkflowExecution,
  nodeId: string,
  outcome: z.infer<typeof workflowOutcomeSchema>,
  outputs: Record<string, unknown> = {},
  transitionId?: string,
): { execution: WorkflowExecution; routedTo?: string; error?: string } {
  const node = execution.workflow.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return { execution: { ...execution, status: 'failed' }, error: `unknown node "${nodeId}"` };
  const currentAttempt = transitionId
    ? execution.attempts.find((attempt) => attempt.transitionId === transitionId && attempt.node === nodeId)
    : [...execution.attempts].reverse().find((attempt) => attempt.node === nodeId);
  if (!currentAttempt) return { execution: { ...execution, status: 'failed' }, error: `node "${nodeId}" has no recorded attempt` };
  if (currentAttempt.status === 'done') {
    if (currentAttempt.outcome === outcome && canonicalJson(currentAttempt.outputs ?? {}) === canonicalJson(outputs)) return { execution };
    return { execution: { ...execution, status: 'failed' }, error: `node "${nodeId}" attempt ${currentAttempt.attempt} was completed with conflicting results` };
  }
  if (!['running', 'pending', 'waiting'].includes(currentAttempt.status)) return { execution: { ...execution, status: 'failed' }, error: `node "${nodeId}" attempt ${currentAttempt.attempt} is not completable` };
  let routedOutcome = outcome;
  const retryable = Boolean(node.retry?.on.includes(outcome));
  if (retryable) {
    const globalLimit = execution.workflow.budget.maxAttempts;
    const retryAllowed = currentAttempt.attempt < node.retry!.maxAttempts
      && (globalLimit === undefined || execution.attempts.length < globalLimit);
    if (retryAllowed) {
      const finishedAt = new Date().toISOString();
      const nextAttemptNo = currentAttempt.attempt + 1;
      const retried = execution.attempts.map((attempt) => attempt.transitionId === currentAttempt.transitionId
        ? { ...attempt, status: 'done' as const, finishedAt, outcome, outputs }
        : attempt);
      const nextAttempt = { node: nodeId, attempt: nextAttemptNo, transitionId: `${nodeId}:retry:${nextAttemptNo}`, status: 'pending' as const, startedAt: finishedAt };
      return { execution: workflowExecutionSchema.parse({ ...execution, attempts: [...retried, nextAttempt], ready: [nodeId], wait: undefined, status: 'running' }) };
    }
    routedOutcome = 'exhausted';
  }
  if (!node.outcomes.includes(routedOutcome)) return { execution: { ...execution, status: 'failed' }, error: `node "${nodeId}" does not declare outcome "${routedOutcome}"` };
  const outputError = retryable && routedOutcome === 'exhausted' ? undefined : validateWorkflowNodeOutputs(node, outputs);
  if (outputError) return { execution: { ...execution, status: 'failed' }, error: outputError };
  const prior = execution.outcomes[nodeId];
  if (prior !== undefined) {
    return { execution: { ...execution, status: 'failed' }, error: `node "${nodeId}" already has a final outcome` };
  }
  const decision = selectWorkflowTransition(execution.workflow, nodeId, routedOutcome, { outcomes: { ...execution.outcomes, [nodeId]: routedOutcome }, inputs: execution.inputs });
  if (decision.status !== 'selected' && !execution.workflow.terminals.includes(nodeId)) return { execution: { ...execution, outcomes: { ...execution.outcomes, [nodeId]: routedOutcome }, outputs: { ...execution.outputs, [nodeId]: outputs }, status: 'failed' }, error: decision.reason };
  if (decision.status === 'selected' && execution.workflow.budget.maxAttempts !== undefined
    && execution.attempts.length >= execution.workflow.budget.maxAttempts) {
    return { execution: { ...execution, outcomes: { ...execution.outcomes, [nodeId]: routedOutcome }, outputs: { ...execution.outputs, [nodeId]: outputs }, status: 'failed' }, error: 'workflow exceeded its global attempt budget' };
  }
  const finishedAt = new Date().toISOString();
  const attempts = execution.attempts.map((attempt) => attempt.transitionId === currentAttempt.transitionId
    ? { ...attempt, status: 'done' as const, finishedAt, outcome, outputs }
      : attempt);
  const selectedTarget = decision.status === 'selected' ? execution.workflow.nodes.find((candidate) => candidate.id === decision.to) : undefined;
  const nextWait = selectedTarget?.kind === 'wait' ? { node: selectedTarget.id, reason: selectedTarget.waitFor, detail: selectedTarget.reason, ...(selectedTarget.event ? { event: selectedTarget.event } : {}), ...(selectedTarget.resumeAt ? { resumeAt: selectedTarget.resumeAt } : {}) } : undefined;
  const nextReady = decision.status === 'selected' && !nextWait ? [decision.to] : [];
  const nextAttempt = decision.status === 'selected' ? [decision.to].map((next) => {
    const attempt = Math.max(0, ...execution.attempts.filter((candidate) => candidate.node === next).map((candidate) => candidate.attempt)) + 1;
    const order = decision.status === 'selected' ? decision.order : 'terminal';
    if (attempt > 999_999_999) throw new Error(`node "${next}" exceeded the durable attempt identifier limit`);
    const nextNode = execution.workflow.nodes.find((candidate) => candidate.id === next)!;
    return { node: next, attempt, transitionId: `${nodeId}:${order}:${next}:${attempt}`, status: nextWait ? 'waiting' as const : 'pending' as const, startedAt: finishedAt,
      ...(nextNode.timeoutSeconds ? { timeoutAt: new Date(Date.parse(finishedAt) + nextNode.timeoutSeconds * 1000).toISOString() } : {}) };
  }) : [];
  return {
    execution: workflowExecutionSchema.parse({
      ...execution,
      outcomes: { ...execution.outcomes, [nodeId]: routedOutcome },
      outputs: { ...execution.outputs, [nodeId]: outputs },
      attempts: [...attempts, ...nextAttempt],
      ready: nextReady,
      wait: nextWait,
      status: execution.workflow.terminals.includes(nodeId) ? routedOutcome === 'passed' ? 'done' : 'failed' : nextWait ? 'waiting' : 'running',
    }),
    ...(nextReady[0] ? { routedTo: nextReady[0] } : {}),
  };
}

/** Stable JSON canonicalization used when calculating definition/policy digests. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => item === undefined ? 'null' : canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Guard evaluation is deterministic and closed-world: absent/unrecognized references are unknown. */
export type GuardResult = 'true' | 'false' | 'unknown';
export function evaluateGuard(guard: z.infer<typeof guardSchema>, context: { outcomes: Record<string, string>; inputs: Record<string, unknown> }): GuardResult {
  const evaluateAtom = (atom: z.infer<typeof guardAtomSchema>): GuardResult => atom.op === 'outcome_is'
    ? context.outcomes[atom.node] === undefined ? 'unknown' : context.outcomes[atom.node] === atom.outcome ? 'true' : 'false'
    : Object.hasOwn(context.inputs, atom.path) ? (canonicalJson(context.inputs[atom.path]) === canonicalJson(atom.value) ? 'true' : 'false') : 'unknown';
  if (guard.op === 'outcome_is' || guard.op === 'input_equals') return evaluateAtom(guard);
  const results = guard.guards.map(evaluateAtom);
  if (guard.op === 'all') return results.includes('false') ? 'false' : results.includes('unknown') ? 'unknown' : 'true';
  return results.includes('true') ? 'true' : results.includes('unknown') ? 'unknown' : 'false';
}

/** Deterministically route one completed node; an unknown guard never falls through to a later edge. */
export function selectWorkflowTransition(
  workflow: VersionedWorkflow,
  from: string,
  outcome: z.infer<typeof workflowOutcomeSchema>,
  context: { outcomes: Record<string, string>; inputs: Record<string, unknown> },
): { status: 'selected'; to: string; order: number } | { status: 'unknown' | 'unhandled'; reason: string } {
  const node = workflow.nodes.find((candidate) => candidate.id === from);
  if (!node || !node.outcomes.includes(outcome)) return { status: 'unhandled', reason: `node "${from}" does not declare outcome "${outcome}"` };
  const candidates = workflow.transitions.filter((transition) => transition.from === from && transition.outcome === outcome)
    .sort((a, b) => a.order - b.order);
  for (const transition of candidates) {
    if (!transition.when) return { status: 'selected', to: transition.to, order: transition.order };
    const guard = evaluateGuard(transition.when, context);
    if (guard === 'unknown') return { status: 'unknown', reason: `guard on ${from} -> ${transition.to} evaluated unknown` };
    if (guard === 'true') return { status: 'selected', to: transition.to, order: transition.order };
  }
  return { status: 'unhandled', reason: `no transition from "${from}" handles outcome "${outcome}" in the current context` };
}
