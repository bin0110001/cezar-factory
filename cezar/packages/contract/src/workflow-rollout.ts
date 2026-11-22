import { z } from 'zod';
import { workflowOutcomeSchema } from './versioned-workflows.ts';

const workflowKeySchema = z.string().trim().min(1).max(200);
const versionedWorkflowPinSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9.-]+$/).max(48),
  version: z.string().regex(/^\d+\.\d+\.\d+$/).max(20),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const workflowRolloutRuleSchema = z.object({
  mode: z.enum(['legacy', 'shadow', 'versioned']).default('legacy'),
  versionedWorkflow: versionedWorkflowPinSchema,
  policyVersion: z.string().trim().min(1).max(128),
  minParitySamples: z.number().int().positive().max(100).default(2),
}).strict();

export const workflowRolloutConfigSchema = z.object({
  schemaVersion: z.literal(1),
  workflows: z.record(workflowKeySchema, workflowRolloutRuleSchema).default({}),
}).strict();
export type WorkflowRolloutConfig = z.infer<typeof workflowRolloutConfigSchema>;
export type WorkflowRolloutRule = z.infer<typeof workflowRolloutRuleSchema>;

export const workflowParityReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  legacyWorkflow: workflowKeySchema,
  versionedWorkflow: versionedWorkflowPinSchema,
  policyVersion: z.string().min(1).max(128),
  taskDigest: z.string().regex(/^[a-f0-9]{64}$/),
  revisionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  legacyRunId: z.string().min(1).max(128),
  versionedRunId: z.string().min(1).max(128),
  legacyOutcome: workflowOutcomeSchema,
  versionedOutcome: workflowOutcomeSchema,
  result: z.enum(['match', 'mismatch']),
  recordedAt: z.string().datetime(),
}).strict().superRefine((receipt, ctx) => {
  if (receipt.legacyRunId === receipt.versionedRunId) ctx.addIssue({ code: 'custom', path: ['versionedRunId'], message: 'parity requires two distinct run records' });
  if (receipt.result === 'match' && receipt.legacyOutcome !== receipt.versionedOutcome) ctx.addIssue({ code: 'custom', path: ['result'], message: 'a parity match requires equal outcomes' });
  if (receipt.result === 'mismatch' && receipt.legacyOutcome === receipt.versionedOutcome) ctx.addIssue({ code: 'custom', path: ['result'], message: 'a parity mismatch requires different outcomes' });
});
export type WorkflowParityReceipt = z.infer<typeof workflowParityReceiptSchema>;

export const workflowParityCompareRequestSchema = z.object({ comparisonRunId: z.string().min(1).max(128) }).strict();

/** Legacy remains authoritative until enough distinct, exact-policy parity samples exist. */
export function resolveWorkflowAuthority(legacyWorkflow: string, rule: WorkflowRolloutRule, receipts: WorkflowParityReceipt[]): 'legacy' | 'versioned' {
  if (rule.mode !== 'versioned') return 'legacy';
  const samples = new Set<string>();
  for (const receipt of receipts) {
    if (receipt.result !== 'match' || receipt.legacyWorkflow !== legacyWorkflow
      || receipt.versionedWorkflow.id !== rule.versionedWorkflow.id
      || receipt.versionedWorkflow.version !== rule.versionedWorkflow.version
      || receipt.versionedWorkflow.digest !== rule.versionedWorkflow.digest
      || receipt.policyVersion !== rule.policyVersion
      || ['unknown', 'interrupted', 'exhausted', 'investigate', 'blocked'].includes(receipt.legacyOutcome)
      || ['unknown', 'interrupted', 'exhausted', 'investigate', 'blocked'].includes(receipt.versionedOutcome)) continue;
    samples.add(`${receipt.legacyRunId}\0${receipt.versionedRunId}`);
  }
  return samples.size >= rule.minParitySamples ? 'versioned' : 'legacy';
}

/** A rollback is a copy-on-write change: the old pin and evidence remain available for audit. */
export function rollbackWorkflowRule(rule: WorkflowRolloutRule): WorkflowRolloutRule {
  return { ...rule, mode: 'legacy' };
}
