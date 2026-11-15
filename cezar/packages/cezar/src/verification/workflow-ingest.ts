import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';
import { verificationRunSchema, type VerificationCheckRun, type VerificationRun } from '@open-mercato/cezar-contract';
import { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';
import { FileFindingLedgerStore } from './finding-ledger.ts';
import { FindingAuditLog, ingestVerificationRun } from './finding-ingest.ts';
import { verificationFindingIdentity } from './executor.ts';

type SelectedCheck = { id: string; reason: string };
type Selection = { schemaVersion: number; headSha: string; baseCommit?: string; selected: SelectedCheck[] };
type Result = { id: string; status: string; exitCode: number; durationMs: number; outputTail: string };
type Results = { schemaVersion: number; headSha: string; results: Result[] };
const verdictSchema = z.object({
  schemaVersion: z.literal(1), verdict: z.enum(['pass', 'fail']), headSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  policySha256: z.string().regex(/^[a-f0-9]{64}$/), mandatoryChecks: z.array(z.string()),
  checks: z.array(z.object({ id: z.string(), status: z.string(), exitCode: z.number().int() })),
  reasons: z.array(z.string()), recordedAt: z.string().datetime(),
}).passthrough();

function readJson<T>(root: string, path: string): Promise<T> {
  return readFile(resolve(root, path), 'utf8').then((text) => JSON.parse(text) as T);
}

function makeCheck(result: Result, selected: SelectedCheck, output: string): VerificationCheckRun {
  const truncated = output.length > 20_000;
  let status: VerificationCheckRun['status'] = result.status === 'passed' && result.exitCode === 0 ? 'passed'
    : result.status === 'failed' && result.exitCode !== 0 ? 'failed' : 'infrastructure-error';
  if (truncated) status = 'unknown';
  const semanticExitCode = status === 'passed' ? 0 : status === 'failed' ? 1 : status === 'infrastructure-error' ? 3 : 2;
  const check: VerificationCheckRun = {
    checkId: result.id, required: selected.reason.includes('mandatory'), attempt: 1, status,
    rawExitCode: Number.isInteger(result.exitCode) ? result.exitCode : null, semanticExitCode,
    durationMs: Math.max(0, Math.trunc(result.durationMs)), outputPreview: output.slice(-20_000), outputTruncated: truncated,
    diagnostics: [], metrics: [], coverage: { selected: 1, passed: status === 'passed' ? 1 : 0, skipped: 0 }, artifacts: [],
  };
  const finding = verificationFindingIdentity(check);
  if (finding) Object.assign(check, { findingFingerprint: finding.fingerprint, findingStrategyId: finding.strategyId, findingStrategyVersion: finding.strategyVersion });
  return check;
}

function aggregate(checks: VerificationCheckRun[]): Pick<VerificationRun, 'status' | 'semanticExitCode' | 'coverage'> {
  const status: VerificationRun['status'] = checks.some((c) => c.status === 'cancelled') ? 'cancelled'
    : checks.some((c) => c.status === 'infrastructure-error') ? 'infrastructure-error'
      : checks.some((c) => c.status === 'failed') ? 'failed'
        : checks.some((c) => c.status === 'unknown') ? 'unknown'
          : checks.length === 0 ? 'no-tests' : 'passed';
  const semanticExitCode = status === 'passed' ? 0 : status === 'failed' ? 1 : status === 'infrastructure-error' ? 3 : status === 'cancelled' ? 4 : 2;
  return { status, semanticExitCode, coverage: {
    selected: checks.reduce((n, c) => n + c.coverage.selected, 0), passed: checks.reduce((n, c) => n + c.coverage.passed, 0),
    failed: checks.filter((c) => c.status === 'failed').length, skipped: checks.reduce((n, c) => n + c.coverage.skipped, 0),
    unknown: checks.filter((c) => ['unknown', 'infrastructure-error', 'cancelled', 'no-tests'].includes(c.status)).length,
  } };
}

/** Validate the workflow's result artifacts, then persist run history and canonical finding episodes. */
export async function ingestWorkflowVerification(input: {
  root: string; dataDir: string; projectId: string; cezarRunId: string; verificationId: string;
  startedAt: string; paths: { selectionPath: string; resultsPath: string; verdictPath: string };
}): Promise<{ run: VerificationRun; verdict: Record<string, unknown>; outcome: ReturnType<typeof ingestVerificationRun> }> {
  const [selection, results, rawVerdict] = await Promise.all([
    readJson<Selection>(input.root, input.paths.selectionPath), readJson<Results>(input.root, input.paths.resultsPath),
    readJson<Record<string, unknown>>(input.root, input.paths.verdictPath),
  ]);
  if (selection.schemaVersion !== 1 || results.schemaVersion !== 1) throw new Error('unsupported verification artifact schema');
  if (!/^[a-f0-9]{40,64}$/i.test(selection.headSha) || results.headSha !== selection.headSha) throw new Error('verification artifacts have mismatched or invalid head SHA');
  const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: input.root, encoding: 'utf8', windowsHide: true }).trim();
  if (currentHead.toLowerCase() !== selection.headSha.toLowerCase()) throw new Error('verification artifacts do not match the worktree HEAD');
  const verdict = verdictSchema.parse(rawVerdict);
  if (verdict.headSha.toLowerCase() !== selection.headSha.toLowerCase()) throw new Error('verification verdict does not match the selected head SHA');
  const selected = new Map(selection.selected.map((check) => [check.id, check]));
  if (selected.size !== selection.selected.length || results.results.length !== selected.size) throw new Error('verification results do not match the selected checks');
  if (verdict.mandatoryChecks.some((id) => !selected.has(id))) throw new Error('verification selection omitted a policy-mandatory check');
  const returned = new Set<string>();
  const secrets = collectSecretValues();
  const checks = results.results.map((result) => {
    const check = selected.get(result.id);
    if (!check || returned.has(result.id)) throw new Error(`unexpected or duplicate verification result '${result.id}'`);
    returned.add(result.id);
    return makeCheck(result, check, redactSecrets(result.outputTail ?? '', secrets));
  });
  const verdictChecks = new Map(verdict.checks.map((check) => [check.id, check]));
  if (verdictChecks.size !== checks.length || checks.some((check) => {
    const recorded = verdictChecks.get(check.checkId);
    return !recorded || recorded.status !== results.results.find((row) => row.id === check.checkId)?.status
      || recorded.exitCode !== results.results.find((row) => row.id === check.checkId)?.exitCode;
  })) throw new Error('verification verdict checks do not match the check results');
  if ((verdict.verdict === 'pass') !== (verdict.reasons.length === 0)) throw new Error('verification verdict and policy reasons are inconsistent');
  const summary = aggregate(checks);
  const finishedAt = new Date().toISOString();
  const run = verificationRunSchema.parse({
    resultVersion: 1, verificationId: input.verificationId, cezarRunId: input.cezarRunId, projectId: input.projectId,
    worktreeId: createHash('sha256').update(resolve(input.root).toLowerCase()).digest('hex'), commitSha: selection.headSha,
    ...(selection.baseCommit ? { baseSha: selection.baseCommit } : {}),
    manifestSha256: createHash('sha256').update(JSON.stringify({ selection, results })).digest('hex'),
    startedAt: input.startedAt, finishedAt, toolVersions: {}, environment: { source: 'factory-workflow-command' }, ...summary, checks, artifacts: [],
  });
  const store = FileFindingLedgerStore.open(input.dataDir, input.projectId);
  const audit = new FindingAuditLog(input.dataDir, input.projectId);
  const outcome = ingestVerificationRun(store, audit, run);
  return { run, verdict, outcome };
}
