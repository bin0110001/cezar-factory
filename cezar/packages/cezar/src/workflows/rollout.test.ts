import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveWorkflowAuthority, rollbackWorkflowRule, workflowParityReceiptSchema, workflowRolloutConfigSchema,
  type WorkflowParityReceipt, type WorkflowRolloutRule,
} from '@open-mercato/cezar-contract';
import type { RunStore } from '../runs/store.ts';
import { appendWorkflowParityReceipt, loadWorkflowRolloutConfig, readWorkflowParityReceipts } from './rollout.ts';

const pin = { id: 'factory.implementation', version: '1.0.0', digest: 'a'.repeat(64) };
const rule: WorkflowRolloutRule = { mode: 'versioned', versionedWorkflow: pin, policyVersion: 'pilot-1', minParitySamples: 2 };
function receipt(index: number, over: Partial<WorkflowParityReceipt> = {}): WorkflowParityReceipt {
  return workflowParityReceiptSchema.parse({
    schemaVersion: 1, legacyWorkflow: 'implement', versionedWorkflow: pin, policyVersion: 'pilot-1',
    taskDigest: String(index).padStart(64, '0'), revisionDigest: 'b'.repeat(64),
    legacyRunId: `legacy-${index}`, versionedRunId: `graph-${index}`,
    legacyOutcome: 'passed', versionedOutcome: 'passed', result: 'match', recordedAt: '2026-11-21T00:00:00.000Z', ...over,
  });
}

describe('workflow rollout policy', () => {
  let root: string | undefined;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

  it('defaults a missing project rollout file to legacy and validates explicit config', async () => {
    root = await mkdtemp(join(tmpdir(), 'cez-workflow-rollout-'));
    expect(await loadWorkflowRolloutConfig(root)).toEqual({ schemaVersion: 1, workflows: {} });
    await mkdir(join(root, '.ai/cezar'), { recursive: true });
    await writeFile(join(root, '.ai/cezar/workflow-rollout.json'), JSON.stringify({
      schemaVersion: 1, workflows: { implement: { ...rule, mode: 'shadow' } },
    }));
    expect((await loadWorkflowRolloutConfig(root)).workflows.implement?.mode).toBe('shadow');
    await writeFile(join(root, '.ai/cezar/workflow-rollout.json'), '{broken');
    await expect(loadWorkflowRolloutConfig(root)).rejects.toThrow();
  });

  it('keeps legacy authority until enough distinct exact-policy matching outcomes exist', () => {
    expect(resolveWorkflowAuthority('implement', { ...rule, mode: 'legacy' }, [])).toBe('legacy');
    expect(resolveWorkflowAuthority('implement', { ...rule, mode: 'shadow' }, [receipt(1), receipt(2)])).toBe('legacy');
    expect(resolveWorkflowAuthority('implement', rule, [receipt(1)])).toBe('legacy');
    expect(resolveWorkflowAuthority('implement', rule, [receipt(1), receipt(1), receipt(2)])).toBe('versioned');
    expect(resolveWorkflowAuthority('implement', rule, [receipt(1), receipt(2, { policyVersion: 'old' })])).toBe('legacy');
    expect(resolveWorkflowAuthority('implement', rule, [receipt(1), receipt(2, { versionedWorkflow: { ...pin, digest: 'c'.repeat(64) } })])).toBe('legacy');
    expect(resolveWorkflowAuthority('implement', rule, [receipt(1), receipt(2, { legacyOutcome: 'unknown', versionedOutcome: 'unknown' })])).toBe('legacy');
    expect(resolveWorkflowAuthority('other-workflow', rule, [receipt(1), receipt(2)])).toBe('legacy');
  });

  it('rolls back to legacy without erasing the pinned graph or policy version', () => {
    expect(rollbackWorkflowRule(rule)).toEqual({ ...rule, mode: 'legacy' });
    expect(workflowRolloutConfigSchema.safeParse({ schemaVersion: 1, workflows: { implement: rule } }).success).toBe(true);
  });

  it('stores and reads parity evidence in existing append-only run events', () => {
    const runs = new Map([['legacy-1', {}], ['graph-1', {}]]);
    const events = new Map<string, unknown[]>([['legacy-1', []], ['graph-1', []]]);
    const store = {
      listRuns: () => [...runs.keys()].map((id) => ({ id })),
      getRun: (id: string) => runs.has(id) ? { id } : undefined,
      readEvents: (id: string) => (events.get(id) ?? []).map((event) => ({ type: 'workflow-parity', receipt: event })),
      appendEvent: (id: string, event: unknown) => events.get(id)?.push((event as { receipt: unknown }).receipt),
    } as unknown as RunStore;
    const sample = receipt(1);
    appendWorkflowParityReceipt(store, sample);
    appendWorkflowParityReceipt(store, { ...sample, recordedAt: '2026-11-22T00:00:00.000Z' });
    expect(readWorkflowParityReceipts(store, 'implement')).toEqual([sample]);
  });
});
