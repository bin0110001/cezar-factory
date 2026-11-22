import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  workflowParityReceiptSchema, workflowRolloutConfigSchema, type WorkflowParityReceipt, type WorkflowRolloutConfig,
} from '@open-mercato/cezar-contract';
import type { RunStore } from '../runs/store.ts';

const ROLLOUT_CONFIG = '.ai/cezar/workflow-rollout.json';

/** Project-local, opt-in policy. Missing files intentionally preserve legacy behavior. */
export async function loadWorkflowRolloutConfig(root: string): Promise<WorkflowRolloutConfig> {
  let raw: string;
  try { raw = await readFile(join(root, ROLLOUT_CONFIG), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return workflowRolloutConfigSchema.parse({ schemaVersion: 1, workflows: {} });
    throw error;
  }
  return workflowRolloutConfigSchema.parse(JSON.parse(raw));
}

/** Existing append-only run events are the parity receipt store; there is no rollout database. */
export function readWorkflowParityReceipts(store: RunStore, legacyWorkflow: string): WorkflowParityReceipt[] {
  const receipts = new Map<string, WorkflowParityReceipt>();
  for (const run of store.listRuns()) for (const event of store.readEvents(run.id)) {
    if (event.type !== 'workflow-parity' || !event.receipt) continue;
    const parsed = workflowParityReceiptSchema.safeParse(event.receipt);
    if (!parsed.success || parsed.data.legacyWorkflow !== legacyWorkflow) continue;
    const receipt = parsed.data;
    receipts.set(`${receipt.legacyRunId}\0${receipt.versionedRunId}`, receipt);
  }
  return [...receipts.values()];
}

export function appendWorkflowParityReceipt(store: RunStore, receipt: WorkflowParityReceipt): WorkflowParityReceipt {
  const parsed = workflowParityReceiptSchema.parse(receipt);
  if (!store.getRun(parsed.legacyRunId) || !store.getRun(parsed.versionedRunId)) throw new Error('parity receipt must reference two existing runs');
  const duplicate = readWorkflowParityReceipts(store, parsed.legacyWorkflow).find((candidate) => candidate.legacyRunId === parsed.legacyRunId && candidate.versionedRunId === parsed.versionedRunId);
  if (duplicate) {
    const evidence = (value: WorkflowParityReceipt) => JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'recordedAt')));
    if (evidence(duplicate) !== evidence(parsed)) throw new Error('parity run pair already has a different receipt');
    return duplicate;
  }
  const event = { type: 'workflow-parity', receipt: parsed };
  store.appendEvent(parsed.legacyRunId, event);
  store.appendEvent(parsed.versionedRunId, event);
  return parsed;
}
