import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { collectPriorStepOutputs, workflowStepDigest } from './structured-artifacts.ts';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? '').digest('hex');

describe('attempt-scoped structured outputs', () => {
  it('exposes only completed outputs from their current attempt', () => {
    const source = 'a'.repeat(64);
    const current = { id: 'collect', status: 'done', iterations: 2, output: { count: 3 }, outputAttempt: 2, outputDigest: digest({ count: 3 }), outputSourceDigest: source } as const;
    const stale = { id: 'stale', status: 'done', iterations: 2, output: { count: 1 }, outputAttempt: 1, outputDigest: digest({ count: 1 }), outputSourceDigest: source } as const;
    const failed = { id: 'failed', status: 'failed', iterations: 1, output: { count: 9 }, outputAttempt: 1, outputDigest: digest({ count: 9 }), outputSourceDigest: source } as const;

    expect(collectPriorStepOutputs([current, stale, failed], { collect: source, stale: source, failed: source }))
      .toEqual({ outputs: { collect: { count: 3 } } });
  });

  it('rejects a corrupt current-attempt output before any downstream use', () => {
    const source = 'a'.repeat(64);
    const corrupt = { id: 'collect', status: 'done', iterations: 2, output: { count: 3 }, outputAttempt: 2, outputDigest: digest({ count: 2 }), outputSourceDigest: source } as const;
    expect(collectPriorStepOutputs([corrupt], { collect: source })).toEqual({ outputs: {}, invalidArtifactStepId: 'collect' });
  });

  it('rejects an artifact produced by a different workflow step definition', () => {
    const oldSource = 'a'.repeat(64);
    const newSource = 'b'.repeat(64);
    const fromOldWorkflow = { id: 'collect', status: 'done', iterations: 1, output: { count: 3 }, outputAttempt: 1, outputDigest: digest({ count: 3 }), outputSourceDigest: oldSource } as const;
    expect(collectPriorStepOutputs([fromOldWorkflow], { collect: newSource }))
      .toEqual({ outputs: {}, invalidArtifactStepId: 'collect' });
  });

  it('does not expose a previous successful artifact while its step is retrying', () => {
    const source = 'a'.repeat(64);
    const retrying = {
      id: 'collect', status: 'running', iterations: 3, output: { count: 3 }, outputAttempt: 2,
      outputDigest: digest({ count: 3 }), outputSourceDigest: source,
    } as const;
    expect(collectPriorStepOutputs([retrying], { collect: source })).toEqual({ outputs: {} });
  });

  it('recovers a validated attempt artifact from the run store after restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-artifact-restart-'));
    try {
      const dataDir = join(root, '.ai', 'cezar');
      const store = RunStore.open(dataDir);
      const step = { id: 'collect', command: 'collect-json', outputSchema: { type: 'object', required: ['count'] } } as const;
      const source = workflowStepDigest(step);
      const run = store.createRun({
        title: 'persist output artifact', workflow: 'artifact-fixture', task: 'collect',
        steps: [{ id: step.id, name: 'Collect', kind: 'check' }],
      });
      store.updateStep(run.id, step.id, {
        iterations: 2, status: 'done', outputAttempt: 2, outputSourceDigest: source,
        output: { count: 4 },
      });
      store.flush({ throwOnError: true });

      const reopened = RunStore.open(dataDir).getRun(run.id);
      expect(reopened).toBeDefined();
      expect(collectPriorStepOutputs(reopened!.steps, { [step.id]: source }))
        .toEqual({ outputs: { collect: { count: 4 } } });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
    }
  });
});
