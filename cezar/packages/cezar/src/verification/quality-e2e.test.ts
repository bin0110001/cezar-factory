import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkProviderConfigSchema, type CheckCategory } from '../server/verification/checks/check-provider.ts';
import { runCheck, type CheckProviderPlugin, type RunCheckOutcome } from '../server/verification/checks/check-runner.ts';
import { junitPlugin } from '../server/verification/checks/providers/junit-adapter.ts';
import { nativeLintPlugin } from '../server/verification/checks/providers/native-lint-adapter.ts';
import { trivyPlugin } from '../server/verification/checks/providers/trivy-adapter.ts';
import { toCheckRun, toIngestInput, type BridgeContext } from './check-bridge.ts';
import { ingestCheckFindings } from './check-finding-ingest.ts';
import { baselineFromFindings, type TrustedBaseline } from './disposition.ts';
import { decideStage, dispositionPolicySchema, type StageDecision } from './disposition-rules.ts';
import { FindingAuditLog } from './finding-ingest.ts';
import { FileFindingLedgerStore } from './finding-ledger.ts';

/**
 * End-to-end demonstration (#669): a Trivy provider, a unit-test provider and one native static analyzer feed the same normalized
 * finding schema into the #52 ledger and are dispositioned CONTINUE/RECORD/BLOCK by baseline and stage. A fixture project has
 * known accepted debt, a new critical vulnerability and a new lint error.
 */

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const DIGEST = `sha256:${'a'.repeat(64)}`;
const SHA = 'c'.repeat(40);
const NOW = new Date('2026-11-16T12:00:00Z');
const FRESH = '2026-11-16T00:00:00Z';
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const policy = dispositionPolicySchema.parse(JSON.parse(readFileSync(new URL('../../../../../policies/verification.json', import.meta.url), 'utf8')).dispositionRules);

function def(id: string, category: CheckCategory, policyOver: Record<string, unknown> = {}) {
  return checkProviderConfigSchema.parse({ version: 1, checks: [{
    id, category, provider: { name: id, version: '1.0.0', digest: DIGEST }, scopes: ['full-repo'], triggers: ['pr-dev'],
    policy: { mandatory: true, timeoutMs: 1000, ...policyOver },
  }] }).checks[0]!;
}
const exec = (r: { exitCode: number; stdout: string }) => async () => r;

// ---- the fixture project ------------------------------------------------------------------------------------------
const vuln = (id: string, pkg: string, severity: string, title = 'vulnerable') => ({ VulnerabilityID: id, PkgName: pkg, InstalledVersion: '1.0.0', FixedVersion: '1.0.1', Severity: severity, Title: title });
const trivyReport = (vulns: unknown[]) => JSON.stringify({ Results: [{ Target: 'package-lock.json', Class: 'lang-pkgs', Type: 'npm', Vulnerabilities: vulns }] });
const ACCEPTED = [vuln('CVE-2021-0001', 'lodash', 'MEDIUM'), vuln('CVE-2021-0002', 'minimist', 'MEDIUM')];
const NEW_CRITICAL = vuln('CVE-2026-9999', 'axios', 'CRITICAL', `leak ${SECRET}`);
const eslintReport = (messages: unknown[]) => JSON.stringify([{ filePath: '/repo/web/src/a.ts', messages }]);
const ACCEPTED_LINT = [{ ruleId: 'semi', severity: 1, message: 'missing semicolon', line: 3 }, { ruleId: 'quotes', severity: 1, message: 'use single quotes', line: 8 }];
const NEW_LINT = { ruleId: 'no-eval', severity: 2, message: 'eval is evil', line: 12 };
const junit = (failures: string[], tests = 5) => `<testsuite name="s" tests="${tests}" failures="${failures.length}" errors="0" skipped="0">${failures.map((f) => `<testcase classname="app" name="${f}"><failure message="${f} failed"/></testcase>`).join('')}</testsuite>`;

const run = (d: ReturnType<typeof def>, plugin: CheckProviderPlugin) => runCheck({ definition: d, plugin, sourceSha: SHA, scope: 's', artifactDigest: 'x', workerProfile: 'w', now: () => NOW, secrets: [SECRET] });
const trivy = (vulns: unknown[], over: { exitCode?: number; db?: string | undefined } = {}) =>
  run(def('dependency-scan', 'sca', { maxAgeHours: 48 }), trivyPlugin({ domain: 'repository', target: '/src', readDbUpdatedAt: async () => ('db' in over ? over.db : FRESH), exec: exec({ exitCode: over.exitCode ?? 0, stdout: trivyReport(vulns) }) }));
const lint = (messages: unknown[]) => run(def('eslint', 'lint'), nativeLintPlugin({ tool: 'eslint', targets: ['web'], root: '/repo', exec: exec({ exitCode: messages.some((m) => (m as { severity: number }).severity === 2) ? 1 : 0, stdout: eslintReport(messages) }) }));
const unit = (id: string, report: string, exitCode = 0) => run(def(id, 'test'), junitPlugin({ exec: async () => ({ exitCode, reportXml: report }) }));
const catalog = () => run(def('automation-catalog', 'custom'), { run: async () => ({ format: 'json', document: { findings: [] }, noFeed: true }) });

const baselineOf = (o: RunCheckOutcome): TrustedBaseline =>
  baselineFromFindings(o.findings.map((f) => ({ fingerprint: f.fingerprint, severity: f.severity })), { source: 'integration', sha: 'a'.repeat(40), envFingerprint: 'env-1', at: '2026-11-01T00:00:00Z' });

function ledger() {
  const dir = mkdtempSync(join(tmpdir(), 'quality-e2e-'));
  roots.push(dir);
  return { store: FileFindingLedgerStore.open(dir, 'p', { now: () => NOW }), audit: new FindingAuditLog(dir, 'p') };
}

let n = 0;
async function stage(l: ReturnType<typeof ledger>, stageName: string, entries: Array<{ outcome: RunCheckOutcome; baseline?: TrustedBaseline; attempts?: number }>): Promise<StageDecision> {
  const runs = entries.map(({ outcome, baseline, attempts }) => {
    const ctx: BridgeContext = {
      projectId: 'p', verificationId: `v${++n}`, runId: 'run-1', commitSha: SHA, environment: { os: 'linux' }, observedAt: `2026-11-16T12:${String(n % 60).padStart(2, '0')}:00.000Z`,
      baseline, baseSha: 'b'.repeat(40), envFingerprint: 'env-1', policyVersion: policy.version, actor: 'ci', attempts,
    };
    const ingested = ingestCheckFindings(l.store, l.audit, toIngestInput(outcome, ctx));
    return toCheckRun(outcome, ingested.dispositions, ctx);
  });
  return decideStage(policy, stageName, runs);
}

describe('three providers, one ledger, one disposition model', () => {
  it('known accepted debt does not block unrelated dev work; a new critical and a new lint error are dispositioned by stage', async () => {
    const l = ledger();
    const trivyBase = baselineOf(await trivy(ACCEPTED));
    const lintBase = baselineOf(await lint(ACCEPTED_LINT));
    const passing = async () => ({ catalog: await catalog(), unit: await unit('full-suite', junit([])) });

    // unrelated dev work: only the accepted debt is present
    const dev = await stage(l, 'pr-dev', [
      { outcome: (await passing()).catalog }, { outcome: await trivy(ACCEPTED), baseline: trivyBase }, { outcome: await lint(ACCEPTED_LINT), baseline: lintBase },
    ]);
    expect(dev.action).toBe('CONTINUE');
    expect(dev.blocked).toBe(false);

    // a change adds a new critical vulnerability and a new lint error
    const trivyNew = await trivy([...ACCEPTED, NEW_CRITICAL]);
    const lintNew = await lint([...ACCEPTED_LINT, NEW_LINT]);
    const pr = await stage(l, 'pr-dev', [{ outcome: (await passing()).catalog }, { outcome: trivyNew, baseline: trivyBase }, { outcome: lintNew, baseline: lintBase }]);
    expect(pr.action).toBe('RECORD');   // on a PR the new findings are tracked, not blocking
    expect(pr.followUps).toHaveLength(2);
    const candidate = await stage(l, 'candidate', [{ outcome: trivyNew, baseline: trivyBase }, { outcome: lintNew, baseline: lintBase }]);
    expect(candidate.action).toBe('BLOCK');
    expect(candidate.decisions.filter((d) => d.action === 'BLOCK').map((d) => d.ruleId)).toEqual(['new-serious-security']);
    expect(candidate.decisions.find((d) => d.checkId === 'eslint' && d.decision === 'new')).toMatchObject({ action: 'RECORD' }); // lint error is quality debt, tracked not blocking
    const stable = await stage(l, 'stable', [{ outcome: await unit('full-suite', junit([])) }, { outcome: trivyNew, baseline: trivyBase }]);
    expect(stable.action).toBe('BLOCK');
    expect(stable.summary).toMatch(/^BLOCK at stable/);
  });

  it('all three providers land in the same ledger with the same schema, provenance and redaction', async () => {
    const l = ledger();
    const outcomes = [await trivy([NEW_CRITICAL]), await lint([NEW_LINT]), await unit('full-suite', junit(['adds numbers']))];
    await stage(l, 'candidate', outcomes.map((outcome) => ({ outcome })));
    const snap = l.store.snapshot();
    expect(new Set(snap.findings.map((f) => f.kind))).toEqual(new Set(['check-finding']));
    expect(snap.findings.map((f) => f.strategyId)).toEqual(Array(3).fill('cezar.verification.check-finding'));
    expect(new Set(snap.occurrences.map((o) => o.checkId))).toEqual(new Set(['dependency-scan', 'eslint', 'full-suite']));
    expect(snap.occurrences.every((o) => o.evidenceRefs.length > 0)).toBe(true);   // provenance retained
    expect(outcomes.every((o) => o.provenance.sourceSha === SHA && o.provenance.configDigest.startsWith('sha256:'))).toBe(true);
    expect(JSON.stringify(snap)).not.toContain(SECRET);
    expect(JSON.stringify(l.audit.history())).not.toContain(SECRET);
    expect(l.audit.history().filter((e) => e.type === 'disposition-recorded')).toHaveLength(3);
  });
});

describe('failure to produce evidence is never a pass', () => {
  it('a tool crash, an unexecuted suite and an unavailable advisory feed are unknown or error and never CONTINUE at a gate', async () => {
    const l = ledger();
    const crashed = await trivy([], { exitCode: 2 });
    expect(crashed.result.status).toBe('error');
    const empty = await unit('full-suite', junit([], 0));
    expect(empty.result).toMatchObject({ status: 'unknown', execution: 'not-run' });
    const noFeed = await trivy(ACCEPTED, { db: undefined });
    expect(noFeed.result).toMatchObject({ status: 'unknown', feed: 'unavailable' });

    const candidate = await stage(l, 'candidate', [{ outcome: crashed }]);
    expect(candidate.action).toBe('RETRY');
    expect(candidate.blocked).toBe(false);
    expect(candidate.action).not.toBe('CONTINUE');
    const exhausted = await stage(l, 'candidate', [{ outcome: crashed, attempts: policy.stages.candidate!.maxRetries }]);
    expect(exhausted.action).toBe('BLOCK');
    const stable = await stage(l, 'stable', [{ outcome: empty }, { outcome: noFeed }]);
    expect(stable.action).toBe('BLOCK');
    expect(stable.decisions.some((d) => d.decision === 'untested' || d.decision === 'unknown')).toBe(true);
    // and the ledger kept every open finding open: nothing was resolved by an unusable run
    expect(l.store.snapshot().episodes.filter((e) => e.status === 'resolved')).toHaveLength(0);
  });

  it('a crashed run does not resolve what a good run had found', async () => {
    const l = ledger();
    const base = baselineOf(await trivy(ACCEPTED));
    await stage(l, 'candidate', [{ outcome: await trivy([...ACCEPTED, NEW_CRITICAL]), baseline: base }]);
    const open = () => l.store.snapshot().episodes.filter((e) => e.status === 'open').length;
    const before = open();
    await stage(l, 'candidate', [{ outcome: await trivy([], { exitCode: 2 }), baseline: base }]);
    expect(open()).toBe(before);
    const fixed = await stage(l, 'candidate', [{ outcome: await trivy(ACCEPTED), baseline: base }]);
    expect(fixed.action).toBe('CONTINUE');
    expect(open()).toBeLessThan(before);
  });
});
