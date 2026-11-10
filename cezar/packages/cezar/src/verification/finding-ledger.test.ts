import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verificationRunSchema } from '@open-mercato/cezar-contract';
import { FileFindingLedgerStore, occurrenceFromVerification, type AppendOccurrenceInput } from './finding-ledger.ts';

const roots: string[] = [];
const fingerprint = 'a'.repeat(64);
const nowAt = '2026-11-10T12:00:00.000Z';

function dataDir(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `finding-ledger-${name}-`));
  roots.push(root);
  return join(root, '.ai', 'cezar');
}

function occurrence(findingId: string, overrides: Partial<AppendOccurrenceInput> = {}): AppendOccurrenceInput {
  return {
    findingId,
    verificationId: 'verification-1',
    runId: 'run-1',
    attempt: 1,
    checkId: 'unit',
    commitSha: '1'.repeat(40),
    environment: { platform: 'linux', arch: 'x64' },
    diagnostics: [{ code: 'assertion', severity: 'error', message: 'expected true' }],
    observedAt: nowAt,
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('FileFindingLedgerStore', () => {
  it('segregates identical fingerprints by project and rebuilds indexes on reopen', () => {
    const a = FileFindingLedgerStore.open(dataDir('project-a'), 'project-a', { now: () => new Date(nowAt) });
    const b = FileFindingLedgerStore.open(dataDir('project-b'), 'project-b', { now: () => new Date(nowAt) });
    const findingA = a.createFinding({ fingerprint, kind: 'test-failure', strategyId: 'tests.v1', strategyVersion: 1 });
    const findingB = b.createFinding({ fingerprint, kind: 'test-failure', strategyId: 'tests.v1', strategyVersion: 1 });
    a.appendOccurrence(occurrence(findingA.id));
    b.appendOccurrence(occurrence(findingB.id));

    expect(a.snapshot()).toMatchObject({ projectId: 'project-a', findings: [{ projectId: 'project-a' }], occurrences: [{ projectId: 'project-a' }] });
    expect(b.snapshot()).toMatchObject({ projectId: 'project-b', findings: [{ projectId: 'project-b' }], occurrences: [{ projectId: 'project-b' }] });
    expect(FileFindingLedgerStore.open(a.dataDir, 'project-a').getFindingByFingerprint(fingerprint)?.id).toBe(findingA.id);
    expect(FileFindingLedgerStore.open(a.dataDir, 'project-a').occurrencesForFinding(findingA.id)).toHaveLength(1);
    expect(FileFindingLedgerStore.open(b.dataDir, 'project-b').getFindingByFingerprint(fingerprint)?.id).toBe(findingB.id);
    expect(() => FileFindingLedgerStore.open(a.dataDir, 'project-b')).toThrow(/project id does not match/);
  });

  it('refreshes before writes so independent store instances do not overwrite each other', () => {
    const data = dataDir('instances');
    const first = FileFindingLedgerStore.open(data, 'project-a', { now: () => new Date(nowAt) });
    const second = FileFindingLedgerStore.open(data, 'project-a', { now: () => new Date(nowAt) });
    first.createFinding({ fingerprint, kind: 'test-failure', strategyId: 'tests.v1', strategyVersion: 1 });
    second.createFinding({ fingerprint: 'b'.repeat(64), kind: 'parse-error', strategyId: 'parse.v1', strategyVersion: 1 });

    expect(first.snapshot().findings.map((finding) => finding.fingerprint).sort()).toEqual([fingerprint, 'b'.repeat(64)].sort());
  });

  it('keeps occurrences immutable and redacts diagnostic and environment secrets', () => {
    const store = FileFindingLedgerStore.open(dataDir('immutable'), 'project-a', { now: () => new Date(nowAt) });
    const finding = store.createFinding({ fingerprint, kind: 'test-failure', strategyId: 'tests.v1', strategyVersion: 1 });
    const first = store.appendOccurrence(occurrence(finding.id, {
      id: 'occurrence-1',
      environment: { platform: 'linux', API_TOKEN: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456' },
      diagnostics: [{ code: 'assertion', severity: 'error', message: 'token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456' }],
    }));
    first.diagnostics[0]!.message = 'caller mutation';

    expect(store.snapshot().occurrences[0]!.diagnostics[0]!.message).not.toContain('ghp_');
    expect(() => store.appendOccurrence(occurrence(finding.id, { id: 'occurrence-1', diagnostics: [] }))).toThrow(/already exists/);
    expect(store.snapshot().occurrences).toHaveLength(1);
    expect(store.snapshot().occurrences[0]!.diagnostics[0]!.message).not.toBe('caller mutation');
  });

  it('migrates v0 records to the current project-keyed schema and observation timestamps', () => {
    const data = dataDir('migration');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'verification-ledger.json'), JSON.stringify({
      schemaVersion: 0,
      findings: [{ id: 'finding-1', fingerprint, kind: 'test-failure', strategyId: 'tests.v1', strategyVersion: 1, createdAt: nowAt, updatedAt: nowAt, firstSeenAt: nowAt, lastSeenAt: nowAt }],
      occurrences: [{ id: 'occurrence-1', findingId: 'finding-1', verificationId: 'verification-1', runId: 'run-1', attempt: 1, checkId: 'unit', commitSha: '1'.repeat(40), environment: {}, diagnostics: [], evidenceRefs: [], observedAt: nowAt }],
      episodes: [], aliases: [],
    }), 'utf8');
    const store = FileFindingLedgerStore.open(data, 'project-a', { now: () => new Date(nowAt) });

    expect(store.snapshot()).toMatchObject({
      schemaVersion: 1, projectId: 'project-a',
      findings: [{ projectId: 'project-a' }],
      occurrences: [{ projectId: 'project-a', firstSeenAt: nowAt, lastSeenAt: nowAt }],
    });
    expect(JSON.parse(readFileSync(join(data, 'verification-ledger.json'), 'utf8'))).toMatchObject({ schemaVersion: 1, projectId: 'project-a' });
  });

  it('adapts contract-owned result and attempt identity without copying the result store', () => {
    const resultFile = new URL('../../../contract/fixtures/verification/failed-result.json', import.meta.url);
    const run = verificationRunSchema.parse(JSON.parse(readFileSync(resultFile, 'utf8')));
    const check = run.checks[0]!;
    const store = FileFindingLedgerStore.open(dataDir('contract-input'), run.projectId, { now: () => new Date(nowAt) });
    const finding = store.createFinding({ fingerprint: check.findingFingerprint!, kind: 'parse-error', strategyId: 'parse.v1', strategyVersion: 1 });
    const saved = store.appendOccurrence(occurrenceFromVerification(run, check, finding.id));

    expect(saved).toMatchObject({ projectId: run.projectId, verificationId: run.verificationId, runId: run.cezarRunId, attempt: check.attempt, commitSha: run.commitSha });
  });

  it('retains recent observations and active episodes while pruning expired records', () => {
    let now = new Date('2026-09-01T00:00:00.000Z');
    const store = FileFindingLedgerStore.open(dataDir('retention'), 'project-a', { now: () => now, retentionDays: 30 });
    const finding = store.createFinding({ fingerprint, kind: 'test-failure', strategyId: 'tests.v1', strategyVersion: 1, at: '2026-09-01T00:00:00.000Z' });
    const oldOccurrence = store.appendOccurrence(occurrence(finding.id, { id: 'old', observedAt: '2026-09-01T00:00:00.000Z' }));
    const recentOccurrence = store.appendOccurrence(occurrence(finding.id, { id: 'recent', observedAt: '2026-11-05T00:00:00.000Z' }));
    store.createEpisode({ findingId: finding.id, id: 'resolved-old', occurrenceIds: [oldOccurrence.id], openedAt: '2026-09-01T00:00:00.000Z' });
    store.resolveEpisode('resolved-old', '2026-09-02T00:00:00.000Z');
    store.createEpisode({ findingId: finding.id, id: 'active', occurrenceIds: [oldOccurrence.id, recentOccurrence.id], openedAt: '2026-09-01T00:00:00.000Z' });
    now = new Date(nowAt);

    expect(store.prune()).toEqual({ occurrences: 1, episodes: 1 });
    expect(store.snapshot()).toMatchObject({
      occurrences: [{ id: 'recent' }],
      episodes: [{ id: 'active', status: 'open', occurrenceIds: ['recent'] }],
    });
  });

  it('keeps alias decisions append-only and rejects cross-project references', () => {
    const store = FileFindingLedgerStore.open(dataDir('aliases'), 'project-a');
    const left = store.createFinding({ fingerprint, kind: 'test-failure', strategyId: 'tests.v1', strategyVersion: 1 });
    const right = store.createFinding({ fingerprint: 'b'.repeat(64), kind: 'test-failure', strategyId: 'tests.v1', strategyVersion: 1 });
    const alias = store.appendAlias({ sourceFindingId: left.id, targetFindingId: right.id, action: 'merge', reason: 'same root cause', actor: 'operator' });
    expect(store.snapshot().aliases).toEqual([alias]);
    expect(store.aliasesForFinding(left.id)).toEqual([alias]);
    expect(() => store.appendAlias({ sourceFindingId: left.id, targetFindingId: 'foreign-finding', action: 'alias', reason: 'wrong project', actor: 'operator' })).toThrow(/unknown finding/);
  });

  it('keeps episode membership project and finding scoped, and never reopens a resolved episode', () => {
    const store = FileFindingLedgerStore.open(dataDir('episode-membership'), 'project-a', { now: () => new Date(nowAt) });
    const left = store.createFinding({ fingerprint, kind: 'test-failure', strategyId: 'tests.v1', strategyVersion: 1 });
    const right = store.createFinding({ fingerprint: 'b'.repeat(64), kind: 'test-failure', strategyId: 'tests.v1', strategyVersion: 1 });
    const first = store.appendOccurrence(occurrence(left.id, { id: 'left-1' }));
    const later = store.appendOccurrence(occurrence(left.id, { id: 'left-2', observedAt: '2026-11-11T12:00:00.000Z' }));
    const foreign = store.appendOccurrence(occurrence(right.id, { id: 'right-1' }));
    store.createEpisode({ findingId: left.id, id: 'episode-1', occurrenceIds: [first.id], openedAt: nowAt });

    expect(store.appendOccurrenceToEpisode('episode-1', later.id)).toMatchObject({ occurrenceIds: ['left-1', 'left-2'], lastSeenAt: later.observedAt });
    expect(store.appendOccurrenceToEpisode('episode-1', later.id).occurrenceIds).toHaveLength(2);
    expect(() => store.appendOccurrenceToEpisode('episode-1', foreign.id)).toThrow(/different finding/);
    store.resolveEpisode('episode-1', '2026-11-12T12:00:00.000Z');
    expect(() => store.appendOccurrenceToEpisode('episode-1', later.id)).toThrow(/resolved episodes are immutable/);
  });
});
