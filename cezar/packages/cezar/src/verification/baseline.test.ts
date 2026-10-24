import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verificationRunSchema, type VerificationRun } from '@open-mercato/cezar-contract';
import { compareVerification, createBaselineCandidate, VerificationBaselineStore, type VerificationBaseline } from './baseline.ts';
import type { FindingOccurrence } from './finding-ledger.ts';
import type { VerificationSelection } from './selection.ts';

const now = '2026-10-23T12:00:00.000Z';
const sha = 'a'.repeat(40);
const fingerprint = (n: number) => n.toString(16).padStart(64, '0');
const roots: string[] = [];

function makeRun(statuses: Array<'passed' | 'failed'>, baseSha?: string): VerificationRun {
  const checks = statuses.map((status, index) => ({
    checkId: `check-${index}`, required: true, attempt: 1, status, rawExitCode: status === 'passed' ? 0 : 1,
    semanticExitCode: status === 'passed' ? 0 : 1, durationMs: 10, outputPreview: '', outputTruncated: false,
    diagnostics: [], metrics: [], coverage: { selected: 1, passed: status === 'passed' ? 1 : 0, skipped: 0 }, artifacts: [],
  }));
  const failed = checks.filter((item) => item.status === 'failed').length;
  return verificationRunSchema.parse({
    resultVersion: 1, verificationId: 'verification-1', cezarRunId: 'run-1', projectId: 'project-1', worktreeId: 'worktree-1',
    commitSha: sha, ...(baseSha ? { baseSha } : {}), manifestSha256: fingerprint(100), startedAt: now, finishedAt: now,
    toolVersions: { node: '22.0.0', runner: '1.2.3' }, environment: { platform: 'linux', arch: 'x64' },
    status: failed ? 'failed' : 'passed', semanticExitCode: failed ? 1 : 0,
    coverage: { selected: checks.length, passed: checks.length - failed, failed, skipped: 0, unknown: 0 }, checks, artifacts: [],
  });
}

function selection(count: number, selectedCount = count): VerificationSelection {
  return { version: 1, mode: selectedCount === count ? 'all' : 'explicit', suite: 'full', changedPaths: [], fallbackUsed: false,
    checks: Array.from({ length: count }, (_, index) => ({ checkId: `check-${index}`, status: index < selectedCount ? 'selected' : 'deferred', confidence: 'high', reason: 'fixture' })) };
}

function occurrence(index: number): FindingOccurrence {
  return { id: fingerprint(index + 1000), findingId: fingerprint(index + 2000), episodeId: fingerprint(index + 3000), runId: 'run-1',
    verificationId: 'verification-1', checkId: `check-${index}`, projectId: 'project-1', commitSha: sha, environmentDigest: fingerprint(900),
    strategy: 'test-failure', fingerprint: fingerprint(index + 1), code: 'assertion', message: 'failure', firstSeenAt: now, observedAt: now, evidenceDigest: fingerprint(901) };
}

function baseline(count: number, overrides: Partial<VerificationBaseline> = {}): VerificationBaseline {
  return { version: 1, id: '11111111-1111-4111-8111-111111111111', projectId: 'project-1', kind: 'accepted-debt',
    sourceRunId: 'old-run', sourceVerificationId: 'old-verification', commitSha: sha, createdAt: now, expiresAt: '2027-10-23T12:00:00.000Z',
    environment: { platform: 'linux', toolsDigest: fingerprint(902) }, mandatoryCheckIds: Array.from({ length: count }, (_, index) => `check-${index}`),
    knownFailures: Array.from({ length: count }, (_, index) => ({ fingerprint: fingerprint(index + 1), checkId: `check-${index}`, state: 'accepted', firstSeenAt: now })),
    performance: [], ...overrides };
}

afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('verification debt baselines', () => {
  it('allows development progress as accepted debt falls from 42 to 39, without claiming green', () => {
    const run = makeRun([...Array.from({ length: 39 }, () => 'failed' as const), ...Array.from({ length: 3 }, () => 'passed' as const)]);
    const report = compareVerification({ run, selection: selection(42), baseline: baseline(42), occurrences: Array.from({ length: 39 }, (_, i) => occurrence(i)), mode: 'development' });
    expect(report.counts).toMatchObject({ known: 39, fixed: 3, new: 0 });
    expect(report.developmentProgressAllowed).toBe(true);
    expect(report.verificationGreen).toBe(false);
    expect(report.releaseReady).toBe(false);
  });

  it('blocks progress on a new failure and does not treat omitted checks as fixed', () => {
    const run = makeRun(['failed', 'passed']);
    const prior = baseline(2);
    const report = compareVerification({ run, selection: selection(2), baseline: prior, occurrences: [{ ...occurrence(0), fingerprint: fingerprint(99) }], mode: 'development' });
    expect(report.counts.new).toBe(1);
    expect(report.developmentProgressAllowed).toBe(false);
    const partial = compareVerification({ run: makeRun(['passed', 'passed']), selection: selection(2, 1), baseline: prior, occurrences: [], mode: 'development' });
    expect(partial.counts.untested).toBe(1);
    expect(partial.counts.fixed).toBe(1);
    expect(partial.verificationGreen).toBe(false);
  });

  it('makes expired baselines and non-matching performance environments inconclusive', () => {
    const expired = compareVerification({ run: makeRun(['passed']), selection: selection(1), baseline: baseline(1, { expiresAt: '2020-01-01T00:00:00.000Z' }), occurrences: [], mode: 'development' });
    expect(expired.counts['infrastructure-inconclusive']).toBeGreaterThan(0);
    expect(expired.developmentProgressAllowed).toBe(false);
    const candidate = createBaselineCandidate({ run: makeRun(['passed']), kind: 'controlled-performance', mandatoryCheckIds: ['check-0'], expiresAt: '2027-01-01T00:00:00.000Z' });
    const performance = { ...candidate, id: '11111111-1111-4111-8111-111111111111', environment: { ...candidate.environment, platform: 'windows' }, performance: [{ checkId: 'check-0', name: 'latency', value: 10, allowedRegressionPercent: 5 }] } as VerificationBaseline;
    const mismatched = compareVerification({ run: makeRun(['passed']), selection: selection(1), baseline: performance, occurrences: [], mode: 'development' });
    expect(mismatched.counts['infrastructure-inconclusive']).toBeGreaterThan(0);
  });

  it('requires an authorized reviewed promotion and enforces compare-and-swap revision', async () => {
    const path = mkdtempSync(join(tmpdir(), 'baseline-store-')); roots.push(path);
    const candidate = createBaselineCandidate({ run: makeRun(['passed']), kind: 'accepted-debt', mandatoryCheckIds: ['check-0'], expiresAt: '2027-01-01T00:00:00.000Z' });
    const denied = new VerificationBaselineStore(path, 'project-1', async () => false);
    await expect(denied.promote(candidate, { actor: 'agent', role: 'owner', reference: 'review-1', approvedAt: now }, null)).rejects.toThrow('not authorized');
    const allowed = new VerificationBaselineStore(path, 'project-1', async (approval) => approval.role === 'owner' && approval.reference.startsWith('review-'));
    const promoted = await allowed.promote(candidate, { actor: 'owner', role: 'owner', reference: 'review-1', approvedAt: now }, null);
    expect((await allowed.current())?.approval?.reference).toBe('review-1');
    const report = compareVerification({ run: makeRun(['passed']), selection: selection(1), baseline: (await allowed.current())!, occurrences: [], mode: 'development' });
    const reportPath = await allowed.recordComparison(report);
    expect(JSON.parse(readFileSync(join(path, reportPath), 'utf8'))).toMatchObject({ verificationId: 'verification-1', baselineRevision: promoted.revision });
    await expect(allowed.promote(candidate, { actor: 'owner', role: 'owner', reference: 'review-2', approvedAt: now }, null)).rejects.toThrow('changed since candidate review');
    expect((await allowed.audit()).map((item) => item.kind)).toEqual(['baseline-promoted', 'comparison-recorded']);
    expect(promoted.revision).toMatch(/^[a-f0-9]{64}$/);
  });
});
