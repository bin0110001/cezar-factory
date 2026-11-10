import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  codingRunSnapshotSchema,
  parseCodingRunSnapshot,
  type CodingRunSnapshot,
} from '@open-mercato/cezar-contract';

const validFixture = JSON.parse(readFileSync(new URL('../../contract/fixtures/coding-run/lifecycle-v1.json', import.meta.url), 'utf8')) as unknown;
const futureFixture = JSON.parse(readFileSync(new URL('../../contract/fixtures/coding-run/future-v2.json', import.meta.url), 'utf8')) as unknown;

describe('coding run contracts', () => {
  it('accepts a complete issue lifecycle with multiple attempts and linked evidence', () => {
    const parsed = codingRunSnapshotSchema.parse(validFixture);
    expect(parsed.run.runId).toBe('run-42');
    expect(parsed.attempts.map((attempt) => attempt.index)).toEqual([1, 2]);
    expect(parsed.events.at(-1)).toMatchObject({ type: 'run.completed', sequence: 11 });
    expect(parsed.events[4]?.evidenceIds).toContain('evidence-verification');
    expect(parsed.evidence.find((item) => item.evidenceId === 'evidence-finding')).toMatchObject({ findingId: 'finding-42', occurrenceId: 'occurrence-42', episodeId: 'episode-42' });
  });

  it('distinguishes a valid schema from invalid v1 and an unsupported future version', () => {
    expect(parseCodingRunSnapshot(validFixture)).toMatchObject({ status: 'valid' });
    const invalid = structuredClone(validFixture) as CodingRunSnapshot;
    invalid.events[1]!.attemptId = 'missing-attempt';
    expect(parseCodingRunSnapshot(invalid)).toMatchObject({ status: 'invalid' });
    expect(parseCodingRunSnapshot(futureFixture)).toEqual({ status: 'unknown-schema', schemaVersion: 2 });
  });

  it('rejects inconsistent identity, ordering, lineage, evidence and secret-bearing extra fields', () => {
    const wrongCorrelation = structuredClone(validFixture) as CodingRunSnapshot;
    wrongCorrelation.events[0]!.correlationId = 'other-run';
    expect(codingRunSnapshotSchema.safeParse(wrongCorrelation).success).toBe(false);

    const badSequence = structuredClone(validFixture) as CodingRunSnapshot;
    badSequence.events[2]!.sequence = 8;
    expect(codingRunSnapshotSchema.safeParse(badSequence).success).toBe(false);

    const badLineage = structuredClone(validFixture) as CodingRunSnapshot;
    badLineage.attempts[1]!.supersedesAttemptId = 'missing-attempt';
    expect(codingRunSnapshotSchema.safeParse(badLineage).success).toBe(false);

    const missingEvidence = structuredClone(validFixture) as CodingRunSnapshot;
    missingEvidence.events[4]!.evidenceIds = ['missing-evidence'];
    expect(codingRunSnapshotSchema.safeParse(missingEvidence).success).toBe(false);

    const leakedPrompt = structuredClone(validFixture) as Record<string, unknown>;
    (leakedPrompt.run as Record<string, unknown>).prompt = 'raw prompt contents';
    expect(codingRunSnapshotSchema.safeParse(leakedPrompt).success).toBe(false);
  });

  it('requires an explicit availability discriminant for external metadata', () => {
    const invalid = structuredClone(validFixture) as CodingRunSnapshot;
    (invalid.run.model as unknown) = { provider: 'unknown', modelId: 'unknown' };
    expect(codingRunSnapshotSchema.safeParse(invalid).success).toBe(false);

    const missingFindingId = structuredClone(validFixture) as CodingRunSnapshot;
    missingFindingId.evidence.find((item) => item.evidenceId === 'evidence-finding')!.findingId = undefined as unknown as string;
    expect(codingRunSnapshotSchema.safeParse(missingFindingId).success).toBe(false);
  });
});
