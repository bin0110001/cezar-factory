import { z } from 'zod';
import { workflowOutcomeSchema } from './versioned-workflows.ts';

const outcomeList = z.array(workflowOutcomeSchema);
const portView = z.object({ name: z.string(), type: z.enum(['string', 'number', 'boolean', 'object', 'array']) }).strict();

export const workflowDefinitionNodeViewSchema = z.object({
  id: z.string(), kind: z.string(), outcomes: outcomeList, session: z.string(),
  retry: z.object({ maxAttempts: z.number().int().positive(), on: outcomeList }).strict().optional(),
  timeoutSeconds: z.number().int().positive().optional(), inputs: z.array(portView), outputs: z.array(portView),
  detail: z.string().optional(),
}).strict();

export const workflowDefinitionTransitionViewSchema = z.object({
  from: z.string(), outcome: workflowOutcomeSchema, to: z.string(), order: z.number().int(), guardLabel: z.string().optional(),
}).strict();

export const workflowDefinitionViewSchema = z.object({
  id: z.string(), version: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/), entry: z.string(), terminals: z.array(z.string()),
  compatibility: z.object({ mode: z.string(), minConsumer: z.string().optional(), maxConsumer: z.string().optional() }).strict(),
  budget: z.record(z.string(), z.number().int().positive()), policyRefs: z.array(z.string()),
  nodes: z.array(workflowDefinitionNodeViewSchema), transitions: z.array(workflowDefinitionTransitionViewSchema),
}).strict();

export const versionedWorkflowCatalogSchema = z.object({
  workflows: z.array(workflowDefinitionViewSchema),
  issues: z.array(z.object({ path: z.string(), message: z.string() }).strict()),
}).strict();
export type VersionedWorkflowCatalog = z.infer<typeof versionedWorkflowCatalogSchema>;

export const workflowFindingViewSchema = z.object({
  id: z.string().optional(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/i).optional(), title: z.string().optional(),
  path: z.string().optional(), line: z.number().int().positive().optional(), severity: z.string().optional(),
  confidence: z.string().optional(), provenance: z.string().optional(), reviewerSessionId: z.string().optional(),
  verificationState: z.string().optional(),
}).strict();

export const workflowAttemptViewSchema = z.object({
  node: z.string(), attempt: z.number().int().positive(), status: z.enum(['pending', 'running', 'waiting', 'done', 'failed', 'cancelled']),
  startedAt: z.string(), finishedAt: z.string().optional(), outcome: workflowOutcomeSchema.optional(), childRunId: z.string().optional(),
  errorPresent: z.boolean(), effectStatus: z.enum(['pending', 'confirmed', 'unknown']).optional(),
  outputs: z.object({ status: z.string().optional(), commitSha: z.string().optional(), artifactRevision: z.string().optional(),
    verificationId: z.string().optional(), findings: z.array(workflowFindingViewSchema).optional() }).strict().optional(),
}).strict();

export const workflowChildRunViewSchema = z.object({
  id: z.string(), status: z.string(), dispatchKind: z.string().optional(), workflow: workflowDefinitionViewSchema.optional(),
}).strict();

export const workflowExecutionViewSchema = z.object({
  runId: z.string(), status: z.enum(['running', 'waiting', 'done', 'failed', 'cancelled']),
  workflow: workflowDefinitionViewSchema, definitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  policyPins: z.array(z.object({ id: z.string(), version: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
  outcomes: z.record(z.string(), workflowOutcomeSchema), ready: z.array(z.string()),
  wait: z.object({ node: z.string(), reason: z.enum(['human', 'event', 'time']), detail: z.string().optional(), resumeAt: z.string().optional() }).strict().optional(),
  attempts: z.array(workflowAttemptViewSchema), children: z.array(workflowChildRunViewSchema),
  githubApproval: z.literal('not-in-workflow-record'),
}).strict();
export type WorkflowExecutionView = z.infer<typeof workflowExecutionViewSchema>;
