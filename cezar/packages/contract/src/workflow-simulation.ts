import { z } from 'zod';
import { versionedWorkflowSchema, workflowOutcomeSchema } from './versioned-workflows.ts';

const waitTriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human') }).strict(),
  z.object({ kind: z.literal('event'), event: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('time'), now: z.string().datetime() }).strict(),
]);
const scenarioSchema = z.object({
  id: z.string().min(1).max(80),
  inputs: z.record(z.string(), z.unknown()).default({}),
  /** Explicit worker/action/child outcomes, in order for repeated visits to each node. */
  outcomes: z.record(z.string(), z.array(workflowOutcomeSchema).max(256)).default({}),
  /** Waits without a matching fixture remain waiting; simulation never invents an event or approval. */
  waitTriggers: z.record(z.string(), waitTriggerSchema).default({}),
  maxSteps: z.number().int().min(1).max(10_000).default(256),
}).strict();

export const workflowSimulationRequestSchema = z.object({
  workflow: versionedWorkflowSchema,
  scenarios: z.array(scenarioSchema).min(1).max(64),
  compareTo: versionedWorkflowSchema.optional(),
}).strict();
export const workflowCatalogSimulationRequestSchema = z.object({
  id: z.string().min(1).max(48),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  scenarios: z.array(scenarioSchema).min(1).max(64),
  compareTo: z.object({ id: z.string().min(1).max(48), version: z.string().regex(/^\d+\.\d+\.\d+$/) }).strict().optional(),
}).strict();
export type WorkflowCatalogSimulationRequest = z.input<typeof workflowCatalogSimulationRequestSchema>;
export type WorkflowSimulationRequest = z.input<typeof workflowSimulationRequestSchema>;

const simulationStepSchema = z.object({
  node: z.string(),
  kind: z.string(),
  outcome: workflowOutcomeSchema.optional(),
  to: z.string().optional(),
  guard: z.enum(['selected', 'unknown', 'unhandled']).optional(),
  note: z.string().max(240).optional(),
}).strict();
const scenarioResultSchema = z.object({
  id: z.string(),
  status: z.enum(['completed', 'waiting', 'unknown', 'failed', 'budget-exhausted']),
  steps: z.array(simulationStepSchema),
  terminal: z.string().optional(),
  outcome: workflowOutcomeSchema.optional(),
  cycleWitness: z.array(z.string()).optional(),
  reason: z.string().max(240).optional(),
}).strict();
const workflowChangeSchema = z.object({ category: z.enum(['identity', 'reachability', 'permissions', 'required-gates', 'budget', 'compatibility', 'github-projections', 'definition']), beforeDigest: z.string(), afterDigest: z.string() }).strict();
export const workflowSimulationResponseSchema = z.object({
  schemaVersion: z.literal(1),
  workflow: z.object({ id: z.string(), version: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  scenarios: z.array(scenarioResultSchema),
  comparison: z.object({ changes: z.array(workflowChangeSchema), activePinnedRuns: z.number().int().nonnegative(), migration: z.literal('none') }).strict().optional(),
}).strict();
export type WorkflowSimulationResponse = z.infer<typeof workflowSimulationResponseSchema>;
