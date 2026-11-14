import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { VerificationCheckRun, VerificationRun } from '@open-mercato/cezar-contract';
import { FileFindingLedgerStore } from './finding-ledger.ts';
import { fingerprintFinding } from './fingerprint.ts';
import {
  FindingAuditLog, ingestVerificationRun, manuallyReopen, manuallyResolve, mergeFindings, replayAudit, splitFinding,
} from './finding-ingest.ts';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function setup(project = 'project-a') {
  const dir = mkdtempSync(join(tmpdir(), 'finding-ingest-'));
  roots.push(dir);
  const store = FileFindingLedgerStore.open(dir, project, { now: () => new Date('2026-11-10T00:00:00.000Z') });
  return { dir, store, audit: new FindingAuditLog(dir, project) };
}

const fp = (message: string, file = 'a.ts', line = 1) =>
  fingerprintFinding({ kind: 'test-failure', checkId: 'unit', code: 'assert', message, file, line });

let tick = 0;
function at(): string { tick += 1; return new Date(Date.UTC(2026, 10, 10, 0, tick)).toISOString(); }

function check(over: Partial<VerificationCheckRun> = {}): VerificationCheckRun {
  return {
    checkId: 'unit', required: true, attempt: 1, status: 'passed', rawExitCode: 0, semanticExitCode: 0, durationMs: 1,
    outputPreview: '', outputTruncated: false, diagnostics: [], metrics: [], coverage: { selected: 3, passed: 3, skipped: 0 }, artifacts: [],
    ...over,
  };
}
function failing(message = 'expected true', line = 1): VerificationCheckRun {
  const f = fp(message);
  return check({
    status: 'failed', rawExitCode: 1, semanticExitCode: 1, coverage: { selected: 3, passed: 2, skipped: 0 },
    diagnostics: [{ code: 'assert', severity: 'error', message, file: 'a.ts', line }],
    findingFingerprint: f.fingerprint, findingStrategyId: f.strategyId, findingStrategyVersion: f.strategyVersion,
  });
}
let runNo = 0;
function run(checks: VerificationCheckRun[], over: Partial<VerificationRun> = {}): VerificationRun {
  runNo += 1;
  const finishedAt = at();
  return {
    resultVersion: 1, verificationId: `v-${runNo}`, cezarRunId: `r-${runNo}`, projectId: 'project-a', worktreeId: 'w',
    commitSha: '1'.repeat(40), manifestSha256: '2'.repeat(64), startedAt: finishedAt, finishedAt, toolVersions: {},
    environment: { platform: 'linux', arch: 'x64' }, status: checks.some((c) => c.status === 'failed') ? 'failed' : 'passed',
    semanticExitCode: 0, coverage: { selected: 0, passed: 0, failed: 0, skipped: 0, unknown: 0 }, checks, artifacts: [],
    ...over,
  } as VerificationRun;
}

describe('ingestVerificationRun', () => {
  it('creates a finding, occurrence and open episode, then appends to the same episode (moved line)', () => {
    const { store, audit } = setup();
    const first = ingestVerificationRun(store, audit, run([failing('expected true', 10)]));
    expect(first.opened).toHaveLength(1);
    const second = ingestVerificationRun(store, audit, run([failing('expected true', 99)]));
    expect(second.appended).toHaveLength(1);
    const snap = store.snapshot();
    expect(snap.findings).toHaveLength(1);
    expect(snap.occurrences).toHaveLength(2);
    expect(snap.episodes).toHaveLength(1);
    expect(snap.episodes[0]!.occurrenceIds).toHaveLength(2);
  });

  it('resolves on valid passing coverage and opens a NEW episode on recurrence', () => {
    const { store, audit } = setup();
    ingestVerificationRun(store, audit, run([failing()]));
    const res = ingestVerificationRun(store, audit, run([check()]));
    expect(res.resolved).toHaveLength(1);
    expect(audit.state().resolutions[res.resolved[0]!.episodeId]!.evidenceRefs[0]).toMatch(/^v-\d+:unit:1$/);
    const again = ingestVerificationRun(store, audit, run([failing()]));
    expect(again.opened[0]).toMatchObject({ created: false, reopened: true });
    const snap = store.snapshot();
    expect(snap.findings).toHaveLength(1);
    expect(snap.episodes.map((e) => e.status)).toEqual(['resolved', 'open']);
    expect(snap.episodes[0]!.occurrenceIds).toHaveLength(1);
  });

  it.each([
    ['omitted check', () => run([])],
    ['irrelevant check', () => run([check({ checkId: 'lint' })])],
    ['skipped', () => run([check({ status: 'skipped', semanticExitCode: 0 })])],
    ['no-tests', () => run([check({ status: 'no-tests' })])],
    ['unknown', () => run([check({ status: 'unknown', semanticExitCode: 2 })])],
    ['infra error', () => run([check({ status: 'infrastructure-error', semanticExitCode: 3 })])],
    ['truncated', () => run([check({ status: 'unknown', semanticExitCode: 2, outputTruncated: true })])],
    ['zero coverage', () => run([check({ coverage: { selected: 0, passed: 0, skipped: 0 } })])],
    ['other platform', () => run([check()], { environment: { platform: 'win32', arch: 'x64' } })],
    ['cancelled run', () => run([check()], { status: 'cancelled' })],
  ])('does not resolve on %s', (_name, build) => {
    const { store, audit } = setup();
    ingestVerificationRun(store, audit, run([failing()]));
    const res = ingestVerificationRun(store, audit, build());
    expect(res.resolved).toHaveLength(0);
    expect(store.snapshot().episodes[0]!.status).toBe('open');
  });

  it('keeps an intermittent test on one finding with separate occurrences', () => {
    const { store, audit } = setup();
    ingestVerificationRun(store, audit, run([failing()]));
    ingestVerificationRun(store, audit, run([check({ coverage: { selected: 3, passed: 3, skipped: 0 } })]));
    ingestVerificationRun(store, audit, run([failing()]));
    ingestVerificationRun(store, audit, run([check({ status: 'skipped', semanticExitCode: 0 })]));
    ingestVerificationRun(store, audit, run([failing()]));
    const snap = store.snapshot();
    expect(snap.findings).toHaveLength(1);
    expect(snap.occurrences).toHaveLength(3);
  });

  it('treats a renamed file as the same finding (location is not identity)', () => {
    const { store, audit } = setup();
    const a = failing();
    const b = { ...failing(), diagnostics: [{ code: 'assert', severity: 'error' as const, message: 'expected true', file: 'renamed.ts', line: 7 }] };
    ingestVerificationRun(store, audit, run([a]));
    ingestVerificationRun(store, audit, run([b]));
    expect(store.snapshot().findings).toHaveLength(1);
  });

  it('never mixes projects with identical fingerprints and rejects mismatched results', () => {
    const a = setup('project-a');
    const b = setup('project-b');
    ingestVerificationRun(a.store, a.audit, run([failing()]));
    ingestVerificationRun(b.store, b.audit, run([failing()], { projectId: 'project-b' }));
    expect(a.store.snapshot().findings[0]!.id).not.toBe(b.store.snapshot().findings[0]!.id);
    expect(() => ingestVerificationRun(a.store, a.audit, run([failing()], { projectId: 'project-b' }))).toThrow(/project id/);
  });

  it('follows a merge alias so reproduction lands on the canonical finding', () => {
    const { store, audit } = setup();
    ingestVerificationRun(store, audit, run([failing('first signature')]));
    ingestVerificationRun(store, audit, run([failing('second signature')]));
    const [one, two] = store.snapshot().findings;
    mergeFindings(store, audit, { sourceFindingId: two!.id, targetFindingId: one!.id, actor: 'human', reason: 'same bug', at: at() });
    ingestVerificationRun(store, audit, run([failing('second signature')]));
    expect(store.snapshot().occurrences.filter((o) => o.findingId === one!.id).length).toBeGreaterThan(1);
  });
});

describe('audited overrides', () => {
  it('records merge, split, resolve and reopen and replays to identical state from the file', () => {
    const { dir, store, audit } = setup();
    ingestVerificationRun(store, audit, run([failing('sig one')]));
    ingestVerificationRun(store, audit, run([failing('sig one')]));
    ingestVerificationRun(store, audit, run([failing('sig two')]));
    const [one, two] = store.snapshot().findings;
    const occIds = store.occurrencesForFinding(one!.id).map((o) => o.id);
    splitFinding(store, audit, { sourceFindingId: one!.id, fingerprint: 'c'.repeat(64), occurrenceIds: [occIds[0]!], actor: 'human', reason: 'distinct', at: at() });
    mergeFindings(store, audit, { sourceFindingId: two!.id, targetFindingId: one!.id, actor: 'human', reason: 'dup', at: at() });
    const episode = store.episodesForFinding(one!.id)[0]!;
    manuallyResolve(store, audit, { episodeId: episode.id, actor: 'human', reason: 'fixed upstream', at: at() });
    manuallyReopen(store, audit, { findingId: one!.id, actor: 'human', reason: 'still broken', at: at() });

    const events = audit.history();
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['override-split', 'override-merge', 'override-resolve', 'override-reopen']));
    expect(events.every((e) => e.actor && e.reason && e.at && 'prior' in e)).toBe(true);
    const reopened = new FindingAuditLog(dir, 'project-a');
    expect(reopened.state()).toEqual(replayAudit('project-a', events));
    expect(reopened.verifyReplay()).toBe(true);
    expect(store.episodesForFinding(one!.id).map((e) => e.status)).toEqual(['resolved', 'open']);
  });

  it('rejects cross-project audit replay and merge cycles', () => {
    const { store, audit } = setup();
    ingestVerificationRun(store, audit, run([failing('x')]));
    ingestVerificationRun(store, audit, run([failing('y')]));
    const [a, b] = store.snapshot().findings;
    mergeFindings(store, audit, { sourceFindingId: a!.id, targetFindingId: b!.id, actor: 'h', reason: 'r', at: at() });
    expect(() => mergeFindings(store, audit, { sourceFindingId: b!.id, targetFindingId: a!.id, actor: 'h', reason: 'r', at: at() })).toThrow(/cycle/);
    const events = audit.history();
    expect(() => replayAudit('project-b', events)).toThrow(/project id/);
  });
});
