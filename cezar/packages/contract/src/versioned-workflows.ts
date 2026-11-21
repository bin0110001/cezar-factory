import { z } from 'zod';

/** Declarative graph contract v1. This is additive; workflowDefSchema remains the legacy adapter. */
export const workflowOutcomeSchema = z.enum([
  'passed', 'changes_required', 'needs_input', 'investigate', 'blocked', 'skipped',
  'unknown', 'interrupted', 'exhausted',
]);

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

const nodeBase = z.object({ id: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*$/), inputs: z.array(portSchema).default([]), outputs: z.array(portSchema).default([]), timeoutSeconds: z.number().int().positive().max(86400).optional(), retry: z.object({ maxAttempts: z.number().int().positive(), on: z.array(workflowOutcomeSchema).min(1) }).strict().optional(), compensation: z.string().min(1).optional(), resources: z.array(z.string().min(1)).default([]), session: z.enum(['inherit', 'new', 'none']).default('inherit') });
export const workflowNodeSchema = z.discriminatedUnion('kind', [
  nodeBase.extend({ kind: z.literal('action'), action: z.string().min(1), capabilities: z.array(z.string().min(1)).default([]), outcomes: z.array(workflowOutcomeSchema).min(1) }),
  nodeBase.extend({ kind: z.literal('agent'), prompt: z.string().min(1), skill: z.string().optional(), outcomes: z.array(workflowOutcomeSchema).min(1) }),
  nodeBase.extend({ kind: z.literal('validator'), validator: z.string().min(1), outcomes: z.array(workflowOutcomeSchema).min(1) }),
  nodeBase.extend({ kind: z.literal('policy_gate'), policy: z.string().min(1), outcomes: z.array(workflowOutcomeSchema).min(1) }),
  nodeBase.extend({ kind: z.literal('wait'), reason: z.string().min(1), outcomes: z.array(workflowOutcomeSchema).length(1).default(['passed']) }),
  nodeBase.extend({ kind: z.literal('child_workflow'), workflow: z.string().min(1), version: z.string().regex(/^\d+\.\d+\.\d+$/), outcomes: z.array(workflowOutcomeSchema).min(1) }),
  nodeBase.extend({ kind: z.literal('fork'), children: z.array(z.string().min(1)).min(1).max(32), join: z.discriminatedUnion('mode', [z.object({ mode: z.literal('all'), cancel: z.literal('on_terminal').default('on_terminal') }).strict(), z.object({ mode: z.literal('any'), cancel: z.literal('on_terminal').default('on_terminal') }).strict(), z.object({ mode: z.literal('quorum'), count: z.number().int().positive(), cancel: z.literal('on_terminal').default('on_terminal') }).strict()]), outcomes: z.array(workflowOutcomeSchema).min(1) }),
  nodeBase.extend({ kind: z.literal('join'), fork: z.string().min(1), outcomes: z.array(workflowOutcomeSchema).min(1) }),
]);

export const versionedWorkflowSchema = z.object({
  contract: z.literal('cezar.workflow'), schemaVersion: z.literal(1), id: z.string().regex(/^[a-z][a-z0-9.-]+$/), version: z.string().regex(/^\d+\.\d+\.\d+$/), description: z.string().optional(),
  entry: z.string().min(1), terminals: z.array(z.string().min(1)).min(1), inputs: z.array(portSchema).default([]), nodes: z.array(workflowNodeSchema).min(1),
  transitions: z.array(z.object({ from: z.string().min(1), outcome: workflowOutcomeSchema, to: z.string().min(1), when: guardSchema.optional(), order: z.number().int().nonnegative() }).strict()),
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
    if (node.kind === 'fork') for (const child of node.children) if (!known.has(child)) ctx.addIssue({ code: 'custom', path: ['nodes', node.id, 'children'], message: `fork references unknown node "${child}"` });
    if (node.kind === 'action') for (const capability of node.capabilities) if (!workflow.capabilities.includes(capability)) ctx.addIssue({ code: 'custom', path: ['nodes', node.id, 'capabilities'], message: `unsupported node capability "${capability}"` });
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

/** Stable JSON canonicalization used when calculating definition/policy digests. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
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
