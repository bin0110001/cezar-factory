import { createHash } from 'node:crypto';
import type { StepState } from '../runs/store.ts';
import type { WorkflowDef, WorkflowStepDef } from './types.ts';

export type StructuredStepArtifact = Pick<
  StepState,
  'id' | 'status' | 'iterations' | 'output' | 'outputAttempt' | 'outputDigest' | 'outputSourceDigest'
>;

export function workflowStepDigest(step: WorkflowStepDef): string {
  return createHash('sha256').update(JSON.stringify(step)).digest('hex');
}

/** Identity of the resolved workflow definition persisted with a run. */
export function workflowDefinitionDigest(workflow: WorkflowDef): string {
  return createHash('sha256').update(JSON.stringify(workflow)).digest('hex');
}

/**
 * Resolve only outputs committed by a successful, matching step attempt.
 * Stale attempts are ignored; a current-attempt digest mismatch is returned
 * as corruption so the workflow can fail closed before dispatching a consumer.
 */
export function collectPriorStepOutputs(
  steps: readonly StructuredStepArtifact[],
  expectedSourceDigests: Readonly<Record<string, string>>,
): {
  outputs: Record<string, unknown>;
  invalidArtifactStepId?: string;
} {
  const outputs: Array<[string, unknown]> = [];
  for (const step of steps) {
    if (step.status !== 'done' || step.output === undefined) continue;
    if (step.outputAttempt !== step.iterations) continue;
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(step.output);
    } catch {
      return { outputs: Object.fromEntries(outputs), invalidArtifactStepId: step.id };
    }
    if (serialized === undefined || !step.outputDigest || !expectedSourceDigests[step.id] ||
      step.outputSourceDigest !== expectedSourceDigests[step.id]) {
      return { outputs: Object.fromEntries(outputs), invalidArtifactStepId: step.id };
    }
    const digest = createHash('sha256').update(serialized).digest('hex');
    if (digest !== step.outputDigest) {
      return { outputs: Object.fromEntries(outputs), invalidArtifactStepId: step.id };
    }
    outputs.push([step.id, step.output]);
  }
  return { outputs: Object.fromEntries(outputs) };
}
