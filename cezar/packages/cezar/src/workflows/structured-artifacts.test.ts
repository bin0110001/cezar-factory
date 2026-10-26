import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { collectPriorStepOutputs } from './structured-artifacts.ts';

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
});
