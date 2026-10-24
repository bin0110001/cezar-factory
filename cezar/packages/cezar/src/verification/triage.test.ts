import { describe, expect, it } from 'vitest';
import { verificationRunSchema } from '@open-mercato/cezar-contract';
import { historicalVerificationRetryCheckIds, verificationRetryCheckIds, verificationTriage } from './triage.ts';
import type { FindingOccurrence, VerificationFinding } from './finding-ledger.ts';
import type { VerificationSelection } from './selection.ts';

function run(status: 'failed' | 'passed' = 'failed') {
  const failed = status === 'failed';
  return verificationRunSchema.parse({
    resultVersion: 1, verificationId: 'verify-1', cezarRunId: 'run-1', projectId: 'project-1', worktreeId: 'worktree-1',
    commitSha: 'a'.repeat(40), manifestSha256: 'b'.repeat(64), startedAt: '2026-10-23T12:00:00.000Z', finishedAt: '2026-10-23T12:01:00.000Z',
    toolVersions: { node: '22' }, environment: { platform: 'win32' }, status, semanticExitCode: failed ? 1 : 0,
    coverage: { selected: 1, passed: failed ? 0 : 1, failed: failed ? 1 : 0, skipped: 0, unknown: 0 },
    checks: [{ checkId: 'unit', required: true, attempt: 1, status, rawExitCode: failed ? 1 : 0, semanticExitCode: failed ? 1 : 0, durationMs: 9, outputPreview: 'a'.repeat(20_000), outputTruncated: false, diagnostics: [], metrics: [], coverage: { selected: 1, passed: failed ? 0 : 1, skipped: 0 }, artifacts: [] }],
    artifacts: [],
  });
}

const selection: VerificationSelection = { version: 1, mode: 'impacted', suite: 'full', changedPaths: ['src/unit.ts'], fallbackUsed: false, checks: [
  { checkId: 'unit', status: 'selected', confidence: 'high', reason: 'changed owner' },
  { checkId: 'integration', status: 'deferred', confidence: 'high', reason: 'unrelated component' },
] };

describe('verification repair triage', () => {
  it('summarizes checks and deferred selection without passing unbounded logs to the agent', () => {
    const summary = verificationTriage({ run: run(), selection, occurrences: [], findings: [], resultPath: '.factory/artifacts/verification/run/result.json' });
    expect(summary).toContain('unit: failed');
    expect(summary).toContain('integration — unrelated component');
    expect(summary).toContain('Details: .factory/artifacts/verification/run/result.json');
    expect(summary.length).toBeLessThanOrEqual(6_000);
    expect(summary).not.toContain('a'.repeat(1_000));
  });

  it('scopes repair reruns to failed checks and does not offer retries for inconclusive runs', () => {
    const result = run();
    expect(verificationRetryCheckIds(result)).toEqual(['unit']);
    expect(verificationRetryCheckIds(run('passed'))).toEqual([]);
  });

  it('recovers scoped retry checks from this run only after process restart', () => {
    const occurrences = [
      { runId: 'run-1', findingId: 'open', checkId: 'unit' },
      { runId: 'run-2', findingId: 'open', checkId: 'other-run' },
      { runId: 'run-1', findingId: 'resolved', checkId: 'already-resolved' },
    ] as FindingOccurrence[];
    const findings = [
      { id: 'open', status: 'open' },
      { id: 'resolved', status: 'resolved' },
    ] as VerificationFinding[];
    expect(historicalVerificationRetryCheckIds('run-1', occurrences, findings)).toEqual(['unit']);
  });

  it('shows recurrence counts alongside the finding and diagnostic identifier', () => {
    const findingFingerprint = 'c'.repeat(64);
    const occurrence = { id: 'occurrence-1', runId: 'run-1', verificationId: 'verify-1', checkId: 'unit', findingId: 'finding-1', episodeId: 'episode-1', fingerprint: findingFingerprint, code: 'assertion', message: 'repeated failure' } as FindingOccurrence;
    const finding = { id: 'finding-1', fingerprint: findingFingerprint, aliases: [], status: 'open', currentEpisodeId: 'episode-1', episodes: [{ id: 'episode-1', number: 1 }] } as unknown as VerificationFinding;
    const summary = verificationTriage({ run: run(), selection, occurrences: [occurrence, { ...occurrence, id: 'occurrence-2' }], findings: [finding], resultPath: 'result.json' });
    expect(summary).toContain('episode 1, seen 2 times');
    expect(summary).toContain('[assertion]');
  });
});
