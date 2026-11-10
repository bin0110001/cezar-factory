import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendCodingRunEvent,
  createCodingRun,
  getCodingRunSnapshot,
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

  it('migrates a v3 registry in place and rejects a registry from a newer build', async () => {
    const old = workspace();
    const oldRegistry = seedRegistryVersion(old.root, old.home, 3);
    await expect(createCodingRun({ record: runRecord(), cwd: old.root, home: old.home })).resolves.toMatchObject({ run: { runId: 'run-1' } });
    const db = new Database(oldRegistry);
    expect(db.prepare("SELECT event_id FROM events WHERE event_id='legacy-event'").get()).toBeTruthy();
    db.close();

    const future = workspace();
    seedRegistryVersion(future.root, future.home, 5);
    await expect(getCodingRunSnapshot({ runId: 'run-1', cwd: future.root, home: future.home })).rejects.toThrow(/newer than this Cezar build supports/);
  });
});
