import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { FileFindingLedgerStore } from './finding-ledger.ts';
import { ingestWorkflowVerification } from './workflow-ingest.ts';

const dirs: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cezar-workflow-ingest-'));
  dirs.push(root);
  const artifacts = join(root, '.factory/verification');
  const dataDir = join(root, '.ai/cezar');
  await mkdir(artifacts, { recursive: true });
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Cezar Test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'cezar-test@example.invalid'], { cwd: root });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  await writeFile(join(artifacts, 'selection.json'), JSON.stringify({ schemaVersion: 1, headSha: sha, baseCommit: 'b'.repeat(40), selected: [{ id: 'tests', reason: 'impact+mandatory' }] }));
  await writeFile(join(artifacts, 'results.json'), JSON.stringify({ schemaVersion: 1, headSha: sha, results: [{ id: 'tests', status: 'failed', exitCode: 1, durationMs: 23, outputTail: 'expected true' }] }));
  await writeFile(join(artifacts, 'verdict.json'), JSON.stringify({ schemaVersion: 1, verdict: 'fail', headSha: sha, policySha256: 'c'.repeat(64), mandatoryChecks: ['tests'], checks: [{ id: 'tests', status: 'failed', exitCode: 1 }], reasons: ['check failed'], recordedAt: new Date().toISOString() }));
  return { root, dataDir };
}

afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('in-process workflow verification ingestion', () => {
  it('records failed check findings and preserves the policy verdict', async () => {
    const { root, dataDir } = await fixture();
    const result = await ingestWorkflowVerification({
      root, dataDir, projectId: 'project-a', cezarRunId: 'run-a', verificationId: 'verification-a',
      startedAt: new Date('2026-11-15T00:00:00.000Z').toISOString(),
      paths: { selectionPath: '.factory/verification/selection.json', resultsPath: '.factory/verification/results.json', verdictPath: '.factory/verification/verdict.json' },
    });
    expect(result.run.status).toBe('failed');
    expect(result.verdict.verdict).toBe('fail');
    expect(result.outcome.opened).toHaveLength(1);
    expect(FileFindingLedgerStore.open(dataDir, 'project-a').snapshot().occurrences).toHaveLength(1);
  });

  it('rejects artifacts whose result SHA differs from the selection', async () => {
    const { root, dataDir } = await fixture();
    await writeFile(join(root, '.factory/verification/results.json'), JSON.stringify({ schemaVersion: 1, headSha: 'd'.repeat(40), results: [{ id: 'tests', status: 'failed', exitCode: 1, durationMs: 2, outputTail: 'x' }] }));
    await expect(ingestWorkflowVerification({
      root, dataDir, projectId: 'project-a', cezarRunId: 'run-a', verificationId: 'verification-a',
      startedAt: new Date().toISOString(),
      paths: { selectionPath: '.factory/verification/selection.json', resultsPath: '.factory/verification/results.json', verdictPath: '.factory/verification/verdict.json' },
    })).rejects.toThrow(/mismatched or invalid head SHA/);
  });
});
