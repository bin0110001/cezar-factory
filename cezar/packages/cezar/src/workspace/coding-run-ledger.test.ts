import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runWorkspaceCommand } from './lifecycle-cli.ts';
import { readCodingRunArtifact, storeCodingRunArtifact } from './coding-run-artifacts.ts';
import {
  appendCodingRunEvent,
  createCodingRun,
  getCodingRunSnapshot,
  lifecycleDoctor,
  queryCodingRunHistory,
  rebuildCodingRunProjection,
} from './lifecycle.ts';
import type { CodingRunRecord } from '@open-mercato/cezar-contract';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as new (path: string) => {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown; get(...params: unknown[]): Record<string, unknown> | undefined };
  close(): void;
};
const roots: string[] = [];
const start = '2026-11-10T08:00:00.000Z';

function workspace(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'coding-run-ledger-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'dev'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Ledger Test', '-c', 'user.email=ledger@example.test', 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root });
  return { root, home: join(root, 'cez-home') };
}

function runRecord(runId = 'run-1'): CodingRunRecord {
  return {
    schemaVersion: 1,
    runId,
    projectId: 'project-a',
    correlationId: `correlation-${runId}`,
    source: { number: 42, revision: { availability: 'available', value: 'issue-rev-1' } },
    baseSha: { availability: 'available', value: '0123456789012345678901234567890123456789' },
    pullRequest: { availability: 'unknown' },
    worker: { availability: 'unavailable', reasonCode: 'worker-profile-missing' },
    agent: { availability: 'available', value: { provider: 'codex', adapterId: 'codex-cli' } },
    model: { availability: 'unknown' },
    promptSha256: { availability: 'available', value: 'a'.repeat(64) },
    skillSha256: ['b'.repeat(64)],
    status: 'running',
    startedAt: start,
  };
}

function seedRegistryVersion(root: string, home: string, version: number): string {
  const commonDirRaw = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
  const commonDir = realpathSync(join(root, commonDirRaw));
  const repoId = createHash('sha256').update(commonDir.toLowerCase()).digest('hex').slice(0, 24);
  const path = join(home, 'workspace-lifecycle', repoId, 'registry.sqlite');
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(`PRAGMA user_version = ${version}; CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, repo_id TEXT NOT NULL,
    issue_key TEXT NOT NULL, execution_id TEXT, event_type TEXT NOT NULL,
    timestamp TEXT NOT NULL, payload_json TEXT NOT NULL
  );`);
  db.prepare(`INSERT INTO events(event_id,repo_id,issue_key,execution_id,event_type,timestamp,payload_json)
    VALUES('legacy-event','legacy-repo','legacy-issue',NULL,'legacy.test','2026-01-01T00:00:00.000Z','{}')`).run();
  db.close();
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('coding run lifecycle ledger', () => {
  it('stores content-addressed attempt evidence and keeps its permanent ledger reference after expiry', async () => {
    const { root, home } = workspace();
    await createCodingRun({ record: runRecord(), cwd: root, home });
    await appendCodingRunEvent({ runId: 'run-1', type: 'attempt.started', attemptId: 'attempt-1', cwd: root, home, occurredAt: start });
    const reference = await storeCodingRunArtifact({
      content: Buffer.from('redacted verification receipt'), mediaType: 'application/json', home,
      retentionDays: 1, now: new Date(start), evidenceId: 'receipt-1',
    });
    const snapshot = await appendCodingRunEvent({
      runId: 'run-1', type: 'validation.completed', attemptId: 'attempt-1', evidence: [reference],
      cwd: root, home, occurredAt: '2026-11-10T12:30:00.000Z',
    });

    expect(snapshot.evidence).toContainEqual(reference);
    await expect(readCodingRunArtifact({ reference, home, now: new Date('2026-11-12T00:00:00.000Z') }))
      .resolves.toMatchObject({ status: 'expired' });
    await expect(getCodingRunSnapshot({ runId: 'run-1', cwd: root, home }))
      .resolves.toMatchObject({ evidence: [expect.objectContaining({ evidenceId: 'receipt-1', expiresAt: reference.expiresAt })] });
  });

  it('appends attempts and evidence atomically and rebuilds the same projection after reopen', async () => {
    const { root, home } = workspace();
    const created = await createCodingRun({ record: runRecord(), cwd: root, home });
    expect(created.events.map((item) => item.type)).toEqual(['run.started']);

    let state = await appendCodingRunEvent({ runId: 'run-1', type: 'attempt.started', attemptId: 'attempt-1', cwd: root, home, occurredAt: start });
    const verification = {
      schemaVersion: 1 as const,
      evidenceId: 'verification-result-1',
      kind: 'verification' as const,
      reference: 'verification/result-1.json',
      verificationId: 'verification-1',
      verificationRunId: 'run-1',
    };
    state = await appendCodingRunEvent({
      runId: 'run-1', type: 'validation.completed', attemptId: 'attempt-1',
      evidence: [verification], cwd: root, home, occurredAt: '2026-11-10T08:10:00.000Z',
    });
    state = await appendCodingRunEvent({ runId: 'run-1', type: 'attempt.failed', attemptId: 'attempt-1', cwd: root, home, occurredAt: '2026-11-10T08:10:01.000Z' });
    state = await appendCodingRunEvent({
      runId: 'run-1', type: 'attempt.started', attemptId: 'attempt-2', supersedesAttemptId: 'attempt-1',
      cwd: root, home, occurredAt: '2026-11-10T08:11:00.000Z',
    });
    state = await appendCodingRunEvent({ runId: 'run-1', type: 'attempt.completed', attemptId: 'attempt-2', cwd: root, home, occurredAt: '2026-11-10T08:20:00.000Z' });
    state = await appendCodingRunEvent({ runId: 'run-1', type: 'run.completed', cwd: root, home, occurredAt: '2026-11-10T08:21:00.000Z' });

    expect(state).toMatchObject({
      run: { status: 'completed', finishedAt: '2026-11-10T08:21:00.000Z' },
      attempts: [
        { attemptId: 'attempt-1', status: 'failed', index: 1 },
        { attemptId: 'attempt-2', status: 'completed', index: 2, supersedesAttemptId: 'attempt-1' },
      ],
      evidence: [{ evidenceId: 'verification-result-1' }],
    });
    await expect(rebuildCodingRunProjection({ runId: 'run-1', cwd: root, home })).resolves.toEqual(state);
    await expect(getCodingRunSnapshot({ runId: 'run-1', cwd: root, home })).resolves.toEqual(state);
  });

  it('rolls back evidence and projection when the append collides with an existing event id', async () => {
    const { root, home } = workspace();
    const created = await createCodingRun({ record: runRecord(), cwd: root, home });
    const evidence = {
      schemaVersion: 1 as const,
      evidenceId: 'artifact-1',
      kind: 'artifact' as const,
      reference: 'artifacts/build.log',
    };
    await expect(appendCodingRunEvent({
      runId: 'run-1', type: 'context.prepared', eventId: created.events[0]!.eventId,
      evidence: [evidence], cwd: root, home,
    })).rejects.toThrow();
    const started = await appendCodingRunEvent({ runId: 'run-1', type: 'attempt.started', attemptId: 'attempt-1', cwd: root, home });
    await expect(appendCodingRunEvent({ runId: 'run-1', type: 'context.prepared', evidenceIds: ['artifact-1'], cwd: root, home })).rejects.toThrow(/event evidence reference must exist/i);
    expect(started.evidence).toEqual([]);
    expect(started.events).toHaveLength(2);
  });

  it('treats a repeated event id with the same payload as an idempotent append', async () => {
    const { root, home } = workspace();
    await createCodingRun({ record: runRecord(), cwd: root, home });
    const input = {
      runId: 'run-1', type: 'context.prepared' as const, eventId: 'event-replayed',
      occurredAt: '2026-11-10T08:01:00.000Z',
      evidence: [{ schemaVersion: 1 as const, evidenceId: 'context-1', kind: 'artifact' as const, reference: 'context/plan.md' }],
      cwd: root, home,
    };
    const first = await appendCodingRunEvent(input);
    await expect(appendCodingRunEvent(input)).resolves.toEqual(first);
    expect(first.events).toHaveLength(2);
    expect(first.evidence).toHaveLength(1);
  });

  it('serializes concurrent appends into a contiguous per-run sequence', async () => {
    const { root, home } = workspace();
    await createCodingRun({ record: runRecord(), cwd: root, home });
    await Promise.all([
      appendCodingRunEvent({ runId: 'run-1', type: 'context.prepared', cwd: root, home }),
      appendCodingRunEvent({ runId: 'run-1', type: 'learning.recorded', cwd: root, home }),
    ]);
    const snapshot = await getCodingRunSnapshot({ runId: 'run-1', cwd: root, home });
    expect(snapshot?.events.map((item) => item.sequence)).toEqual([1, 2, 3]);
  });

  it('paginates against a fixed sequence watermark and replays a cursor without skips or duplicates', async () => {
    const { root, home } = workspace();
    await createCodingRun({ record: runRecord(), cwd: root, home });
    await appendCodingRunEvent({ runId: 'run-1', type: 'context.prepared', cwd: root, home, occurredAt: '2026-11-10T08:01:00.000Z' });
    await appendCodingRunEvent({ runId: 'run-1', type: 'learning.recorded', cwd: root, home,
      occurredAt: '2026-11-10T08:02:00.000Z' });
    const first = await queryCodingRunHistory({ runId: 'run-1', limit: 2, cwd: root, home });
    expect(first.events.map((event) => event.event?.type)).toEqual(['run.started', 'context.prepared']);
    expect(first.nextCursor).toBeTruthy();
    await appendCodingRunEvent({ runId: 'run-1', type: 'delivery.opened', cwd: root, home, occurredAt: '2026-11-10T08:03:00.000Z' });
    const second = await queryCodingRunHistory({ runId: 'run-1', cursor: first.nextCursor, limit: 2, cwd: root, home });
    const replay = await queryCodingRunHistory({ runId: 'run-1', cursor: first.nextCursor, limit: 2, cwd: root, home });
    expect(second).toEqual(replay);
    expect(second.events.map((event) => event.event?.type)).toEqual(['learning.recorded']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('returns an explicit empty complete history and binds cursors to their query filter', async () => {
    const { root, home } = workspace();
    await createCodingRun({ record: runRecord(), cwd: root, home });
    const empty = await queryCodingRunHistory({ issue: '43', cwd: root, home });
    expect(empty).toMatchObject({ events: [], complete: true, cursorBoundary: { afterSequence: 0, snapshotSequence: 0 },
      retention: { mode: 'permanent', automaticDeletion: false } });
    await appendCodingRunEvent({ runId: 'run-1', type: 'context.prepared', cwd: root, home });
    const page = await queryCodingRunHistory({ runId: 'run-1', limit: 1, cwd: root, home });
    await expect(queryCodingRunHistory({ issue: '42', cursor: page.nextCursor ?? 'invalid', cwd: root, home }))
      .rejects.toThrow(/cursor belongs to another repository or filter|invalid coding-run history cursor/);
  });

  it('exposes paginated history through the workspace CLI as JSON', async () => {
    const { root, home } = workspace();
    await createCodingRun({ record: runRecord(), cwd: root, home });
    await appendCodingRunEvent({ runId: 'run-1', type: 'context.prepared', cwd: root, home });
    const out: string[] = [];
    const io = { log: (line: string) => out.push(line), error: (line: string) => { throw new Error(line); } };
    const priorHome = process.env.CEZ_HOME;
    process.env.CEZ_HOME = home;
    try {
      expect(await runWorkspaceCommand(['history', '--run', 'run-1', '--limit', '1', '--json'], { cwd: root, io })).toBe(0);
      const page = JSON.parse(out.pop()!);
      expect(page).toMatchObject({ complete: false, hasMore: true, events: [{ integrity: 'valid' }] });
      expect(typeof page.nextCursor).toBe('string');
      expect(await runWorkspaceCommand(['history', '--run', 'run-1', '--cursor', page.nextCursor, '--json'], { cwd: root, io })).toBe(0);
      expect(JSON.parse(out.pop()!)).toMatchObject({ complete: true, hasMore: false, events: [{ event: { type: 'context.prepared' } }] });
    } finally {
      if (priorHome === undefined) delete process.env.CEZ_HOME;
      else process.env.CEZ_HOME = priorHome;
    }
  });

  it('reports corrupt event rows as incomplete history and includes them in doctor diagnostics', async () => {
    const { root, home } = workspace();
    await createCodingRun({ record: runRecord(), cwd: root, home });
    const db = new Database(join(home, 'workspace-lifecycle', createHash('sha256').update(
      realpathSync(join(root, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim())).toLowerCase(),
    ).digest('hex').slice(0, 24), 'registry.sqlite'));
    db.prepare("UPDATE events SET payload_json='not-json' WHERE execution_id='run-1' AND event_type='run.started'").run();
    db.close();
    const history = await queryCodingRunHistory({ runId: 'run-1', cwd: root, home });
    expect(history).toMatchObject({ complete: false, events: [{ integrity: 'corrupt' }] });
    const doctor = await lifecycleDoctor({ cwd: root, home });
    expect(doctor.codingRunHistory).toMatchObject({ corruptRuns: 1, validRuns: 0 });
    expect(doctor.findings.join('\n')).toMatch(/corrupt history/i);
  });

  it('reports missing event sequences as incomplete instead of declaring a complete history', async () => {
    const { root, home } = workspace();
    await createCodingRun({ record: runRecord(), cwd: root, home });
    await appendCodingRunEvent({ runId: 'run-1', type: 'context.prepared', cwd: root, home });
    await appendCodingRunEvent({ runId: 'run-1', type: 'learning.recorded', cwd: root, home });
    const commonRaw = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
    const commonDir = realpathSync(join(root, commonRaw));
    const repoId = createHash('sha256').update(commonDir.toLowerCase()).digest('hex').slice(0, 24);
    const db = new Database(join(home, 'workspace-lifecycle', repoId, 'registry.sqlite'));
    db.prepare("DELETE FROM events WHERE execution_id='run-1' AND event_type='context.prepared'").run();
    db.close();
    const history = await queryCodingRunHistory({ runId: 'run-1', cwd: root, home });
    expect(history).toMatchObject({ complete: false, events: [{ integrity: 'valid' }, { integrity: 'corrupt' }] });
    const doctor = await lifecycleDoctor({ cwd: root, home });
    expect(doctor.codingRunHistory.incompleteRuns).toBe(1);
    expect(doctor.findings.join('\n')).toMatch(/incomplete history/i);
  });

  it('reports unsupported history versions and keeps audit retention separate from trace delivery', async () => {
    const { root, home } = workspace();
    await createCodingRun({ record: runRecord(), cwd: root, home });
    const commonRaw = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
    const commonDir = realpathSync(join(root, commonRaw));
    const repoId = createHash('sha256').update(commonDir.toLowerCase()).digest('hex').slice(0, 24);
    const db = new Database(join(home, 'workspace-lifecycle', repoId, 'registry.sqlite'));
    db.prepare("UPDATE events SET payload_json=? WHERE execution_id='run-1' AND event_type='run.started'")
      .run(JSON.stringify({ schemaVersion: 2 }));
    db.close();
    const history = await queryCodingRunHistory({ runId: 'run-1', cwd: root, home });
    expect(history).toMatchObject({ complete: false, events: [{ integrity: 'unsupported-version' }] });
    const doctor = await lifecycleDoctor({ cwd: root, home });
    expect(doctor.codingRunHistory.unsupportedRuns).toBe(1);
    expect(doctor.retention.codingAudit).toMatchObject({ mode: 'permanent', automaticDeletion: false });
    expect(doctor.retention.operationalTrace).toMatchObject({ mode: 'delivery-outbox', auditRowsAreSource: false });
  });

  it('migrates a v3 registry in place and rejects a registry from a newer build', async () => {
    const old = workspace();
    const oldRegistry = seedRegistryVersion(old.root, old.home, 3);
    await expect(createCodingRun({ record: runRecord(), cwd: old.root, home: old.home })).resolves.toMatchObject({ run: { runId: 'run-1' } });
    const db = new Database(oldRegistry);
    expect(db.prepare("SELECT event_id FROM events WHERE event_id='legacy-event'").get()).toBeTruthy();
    db.close();

    const future = workspace();
    seedRegistryVersion(future.root, future.home, 6);
    await expect(getCodingRunSnapshot({ runId: 'run-1', cwd: future.root, home: future.home })).rejects.toThrow(/newer than this Cezar build supports/);
  });
});
