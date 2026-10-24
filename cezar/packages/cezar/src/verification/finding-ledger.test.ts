import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verificationRunSchema, type VerificationRun } from '@open-mercato/cezar-contract';
import { FindingLedger, findingFingerprint, strategyForVerificationCheck } from './finding-ledger.ts';

const roots: string[] = [];
const failedFixture = JSON.parse(readFileSync(new URL('../../../contract/fixtures/verification/failed-result.json', import.meta.url), 'utf8')) as VerificationRun;
const passedFixture = JSON.parse(readFileSync(new URL('../../../contract/fixtures/verification/passing-result.json', import.meta.url), 'utf8')) as VerificationRun;

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'verification-ledger-'));
  roots.push(root);
  return root;
}

function runFor(fixture: VerificationRun, runId: string, options: { projectId?: string; status?: VerificationRun['status']; checkId?: string; file?: string; line?: number; message?: string } = {}): VerificationRun {
  const run = structuredClone(fixture);
  run.cezarRunId = runId;
  run.verificationId = `verification-${runId}`;
  run.projectId = options.projectId ?? 'project-a';
  if (options.status) run.status = options.status;
  if (options.checkId) run.checks[0]!.checkId = options.checkId;
  if (options.file || options.line || options.message) {
    run.checks[0]!.diagnostics = [{ code: 'parse-error', severity: 'error', message: options.message ?? 'Unexpected token at line 22', ...(options.file ? { file: options.file } : {}), ...(options.line ? { line: options.line } : {}) }];
  }
  if (run.status === 'passed') {
    run.checks[0]!.status = 'passed'; run.checks[0]!.rawExitCode = 0; run.checks[0]!.semanticExitCode = 0;
    run.checks[0]!.coverage = { selected: 1, passed: 1, skipped: 0 };
    run.coverage = { selected: 1, passed: 1, failed: 0, skipped: 0, unknown: 0 };
  }
  return verificationRunSchema.parse(run);
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('verification finding ledger', () => {
  it('keeps identity across moved lines and renamed files while retaining immutable occurrences', async () => {
    const ledger = FindingLedger.open(join(sandbox(), 'project-a'), 'project-a');
    const first = runFor(failedFixture, 'run-1', { file: 'scripts/parser.gd', line: 22, message: 'Unexpected token at line 22' });
    const second = runFor(failedFixture, 'run-2', { file: 'src/parser_new.gd', line: 91, message: 'Unexpected token at line 91' });
    expect(findingFingerprint({ projectId: 'project-a', checkId: 'parse', strategy: 'parse-error', code: 'parse-error', message: 'Unexpected token at line 22' }))
      .toBe(findingFingerprint({ projectId: 'project-a', checkId: 'parse', strategy: 'parse-error', code: 'parse-error', message: 'Unexpected token at line 91' }));
    expect(await ledger.ingestRun(first, { parse: 'parse-error' })).toEqual({ recorded: 1, resolved: 0 });
    expect(await ledger.ingestRun(second, { parse: 'parse-error' })).toEqual({ recorded: 1, resolved: 0 });
    const findings = await ledger.findings();
    expect(findings).toHaveLength(1);
    expect(findings[0]?.episodes).toHaveLength(1);
    const occurrences = await ledger.occurrences(findings[0]!.id);
    expect(occurrences.map((item) => item.line)).toEqual([22, 91]);
    expect(occurrences[0]?.file).not.toBe(occurrences[1]?.file);
  });

  it('resolves only on complete relevant passing coverage and opens a new episode when reproduced', async () => {
    const ledger = FindingLedger.open(join(sandbox(), 'project-a'), 'project-a');
    await ledger.ingestRun(runFor(failedFixture, 'run-1'), { parse: 'parse-error' });
    await ledger.ingestRun(runFor(passedFixture, 'unrelated', { status: 'passed', checkId: 'startup' }), { startup: 'startup-error' });
    expect((await ledger.findings())[0]?.status).toBe('open');
    expect(await ledger.ingestRun(runFor(passedFixture, 'run-pass', { status: 'passed', checkId: 'parse' }), {})).toEqual({ recorded: 0, resolved: 1 });
    expect((await ledger.findings())[0]?.status).toBe('resolved');
    await ledger.ingestRun(runFor(failedFixture, 'run-again'), { parse: 'parse-error' });
    const reopened = (await ledger.findings())[0]!;
    expect(reopened.status).toBe('open');
    expect(reopened.episodes.map((episode) => episode.number)).toEqual([1, 2]);
    expect((await ledger.auditEvents()).map((event) => event.kind)).toContain('reopened');
  });

  it('deduplicates re-ingestion and isolates project state', async () => {
    const root = sandbox();
    const ledger = FindingLedger.open(join(root, 'project-a'), 'project-a');
    const run = runFor(failedFixture, 'same-run');
    expect(await Promise.all([ledger.ingestRun(run, { parse: 'parse-error' }), ledger.ingestRun(run, { parse: 'parse-error' })])).toEqual([
      { recorded: 1, resolved: 0 }, { recorded: 0, resolved: 0 },
    ]);
    const other = FindingLedger.open(join(root, 'project-b'), 'project-b');
    await other.ingestRun(runFor(failedFixture, 'same-run', { projectId: 'project-b' }), { parse: 'parse-error' });
    expect(await ledger.findings()).toHaveLength(1);
    expect(await other.findings()).toHaveLength(1);
    expect((await ledger.findings())[0]?.id).not.toBe((await other.findings())[0]?.id);
  });

  it('audits human resolution, aliases, merges, and retention without deleting occurrences', async () => {
    let now = new Date('2026-10-23T12:00:00Z');
    const ledger = FindingLedger.open(join(sandbox(), 'project-a'), 'project-a', { now: () => now, retentionDays: 1 });
    await ledger.ingestRun(runFor(failedFixture, 'run-1'), { parse: 'parse-error' });
    const finding = (await ledger.findings())[0]!;
    const alias = 'a'.repeat(64);
    await ledger.addAlias(finding.id, alias, 'reviewer', 'parser upgraded its message format');
    const second = runFor(failedFixture, 'run-2', { message: 'A different parser diagnostic' });
    await ledger.ingestRun(second, { parse: 'parse-error' });
    const other = (await ledger.findings()).find((row) => row.id !== finding.id)!;
    await ledger.merge(finding.id, other.id, 'reviewer', 'same underlying parser regression');
    await ledger.resolve(finding.id, 'reviewer', 'confirmed fixed outside automated coverage');
    now = new Date('2026-10-25T12:00:00Z');
    expect(await ledger.compact()).toBe(2);
    expect(await ledger.occurrences(finding.id)).toHaveLength(2);
    expect((await ledger.findings()).find((row) => row.id === finding.id)?.archivedAt).toBeDefined();
    expect((await ledger.auditEvents()).map((event) => event.kind)).toEqual(expect.arrayContaining(['alias-added', 'findings-merged', 'human-resolution', 'retention-archived']));
  });

  it('migrates a v0 ledger and rejects another project opening the file', async () => {
    const dataDir = join(sandbox(), 'project-a');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'verification-findings.json'), JSON.stringify({ version: 0, projectId: 'project-a', findings: [], occurrences: [], auditEvents: [] }));
    const ledger = FindingLedger.open(dataDir, 'project-a');
    expect(await ledger.findings()).toEqual([]);
    expect((await ledger.auditEvents())[0]?.kind).toBe('migration');
    await expect(FindingLedger.open(dataDir, 'project-b').findings()).rejects.toThrow('different project');
  });

  it('infers versioned strategies from explicit check and diagnostic names', () => {
    expect(strategyForVerificationCheck('godot-parse')).toBe('parse-error');
    expect(strategyForVerificationCheck('boot', 'startup-timeout')).toBe('startup-error');
    expect(strategyForVerificationCheck('latency')).toBe('performance');
    expect(strategyForVerificationCheck('gdunit')).toBe('test-failure');
  });
});
