import { reviewProblems } from '../finding-policy.js';
import type { CheckProviderPlugin, PluginRunOutput } from '../check-runner.js';

/**
 * Test-effectiveness safeguards provider (#671) behind the check-provider contract. It wraps the existing anti-weakening guard
 * (`scripts/check-weakening.ps1`, whose output it parses) and the change-impact test selection (#53, whose selection it consumes), and adds
 * source-level checks for deleted, skipped and weakened tests and optional changed-line coverage. An impacted suite that did not execute
 * makes a clean result `unknown`, never a pass. Flaky-test quarantine is scoped to an environment, reviewed by a human or operator and
 * expiring (the #651 semantics). Findings flow through the finding policy and baselines (#54); the coverage *trend* stays in #649.
 */

export interface TestFinding { id: string; severity: 'high' | 'medium' | 'low' | 'info'; title: string; path?: string | undefined; line?: number | undefined }

// ---- the existing weakening guard ---------------------------------------------------------------------------------------------
export interface GuardResult { exitCode: number; stdout: string; stderr: string }

/** `check-weakening.ps1`: exit 0 clean (or not enabled), 1 violations listed as `  - message` on stderr, 2 error (fails closed). */
export function parseWeakeningGuard(r: GuardResult): TestFinding[] {
  if (r.exitCode === 0) return [];
  if (r.exitCode !== 1) throw new Error(`weakening guard failed to run (exit ${r.exitCode}): ${r.stderr.trim().slice(0, 200)}`);
  const slug = (m: string) => m.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  return r.stderr.split(/\r?\n/).filter((l) => /^\s+-\s+/.test(l)).map((l) => l.replace(/^\s+-\s+/, '').trim())
    .map((message) => ({ id: `tests.guard:${slug(message)}`, severity: 'high' as const, title: `weakening guard: ${message}`, path: message.split(/[/:]/)[0] }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ---- source-level weakening ---------------------------------------------------------------------------------------------------
export interface TestFileChange { path: string; before?: string | undefined; after?: string | undefined }

const IS_TEST = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$|Tests?\.cs$/i;
const CASE = /(^|[^\w.])(?:it|test)\s*(?:\.(?:each|only|concurrent|skip|todo))?\s*\(|^\s*def\s+test_|\[(?:Fact|Theory|Test|TestMethod)\b|^\s*func\s+test_/gm;
const SKIP = /\b(?:it|test|describe)\.skip\b|\bx(?:it|describe|test)\s*\(|@pytest\.mark\.skip|\[(?:Fact|Theory)\(Skip|@Ignore\b|\[Ignore\b|\bpending\s*\(|\.todo\s*\(/g;
const ASSERT = /\bexpect\s*\(|\bassert[A-Z_(]|\bassert\s|\bAssert\.|\bshould\b|\.(?:toBe|toEqual|toThrow)/g;
const count = (rx: RegExp, text: string) => (text.match(new RegExp(rx.source, rx.flags)) ?? []).length;

export function isTestPath(path: string): boolean { return IS_TEST.test(path.replace(/\\/g, '/')); }

export function analyzeTestChanges(changes: readonly TestFileChange[]): TestFinding[] {
  const out: TestFinding[] = [];
  for (const c of changes) {
    const path = c.path.replace(/\\/g, '/');
    if (!isTestPath(path) || c.before === undefined) continue;                  // new test files cannot weaken anything
    if (c.after === undefined) { out.push({ id: 'tests.deleted-test-file', severity: 'high', title: `test file ${path} was deleted (${count(CASE, c.before)} test(s) lost)`, path }); continue; }
    const lost = count(CASE, c.before) - count(CASE, c.after);
    const skips = count(SKIP, c.after) - count(SKIP, c.before);
    const asserts = count(ASSERT, c.before) - count(ASSERT, c.after);
    if (lost > 0) out.push({ id: 'tests.removed-tests', severity: 'high', title: `${lost} test case(s) removed from ${path}`, path });
    if (skips > 0) out.push({ id: 'tests.added-skip', severity: 'high', title: `${skips} test(s) newly skipped, disabled or marked pending in ${path}`, path });
    if (lost <= 0 && asserts > 0) out.push({ id: 'tests.weakened-assertions', severity: 'medium', title: `${asserts} assertion(s) removed from ${path} while its tests remain`, path });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id) || (a.path ?? '').localeCompare(b.path ?? ''));
}

// ---- impacted suites ----------------------------------------------------------------------------------------------------------
export interface SuiteRun { suiteId: string; status: 'passed' | 'failed' | 'skipped' | 'not-run' }

/** Impacted suites (from the change-impact selection) that did not execute. They cannot be a pass: the caller marks the result unknown. */
export function unexecutedImpacted(impacted: readonly string[], runs: readonly SuiteRun[]): string[] {
  const ran = new Set(runs.filter((r) => r.status === 'passed' || r.status === 'failed').map((r) => r.suiteId));
  return [...new Set(impacted)].filter((id) => !ran.has(id)).sort();
}

// ---- optional changed-line coverage -------------------------------------------------------------------------------------------
export function changedLineCoverage(changed: Readonly<Record<string, readonly number[]>>, covered: Readonly<Record<string, readonly number[]>> | undefined, minPercent: number): TestFinding[] {
  if (!covered) return [];                                                         // optional: no coverage data means no opinion
  const out: TestFinding[] = [];
  for (const [path, lines] of Object.entries(changed).sort(([a], [b]) => a.localeCompare(b))) {
    if (!isTestPath(path) && lines.length > 0 && path in covered) {
      const hit = new Set(covered[path]);
      const pct = Math.round((lines.filter((l) => hit.has(l)).length / lines.length) * 100);
      if (pct < minPercent) out.push({ id: `tests.low-changed-line-coverage:${path}`, severity: 'medium', title: `${pct}% of ${lines.length} changed line(s) in ${path} are covered (minimum ${minPercent}%)`, path });
    }
  }
  return out;
}

// ---- flaky quarantine ---------------------------------------------------------------------------------------------------------
export interface QuarantineEntry {
  testId: string;
  /** The environment fingerprint the flakiness was observed in; a quarantine does not apply anywhere else. */
  environment: string;
  suite?: string | undefined;
  reason: string;
  reviewedBy?: string | undefined;
  reviewerKind?: string | undefined;
  expiresAt: string;
}

export function activeQuarantine(entries: readonly QuarantineEntry[], failing: { testId: string; suite?: string | undefined }, environment: string, now: Date): { quarantined: boolean; notes: string[] } {
  const notes: string[] = [];
  for (const q of entries) {
    if (q.testId !== failing.testId) continue;
    if (q.suite && q.suite !== failing.suite) { notes.push(`quarantine for ${q.testId} is scoped to suite ${q.suite}`); continue; }
    if (q.environment !== environment) { notes.push(`quarantine for ${q.testId} was recorded in a different environment and does not apply`); continue; }
    const problems = reviewProblems(q, now);
    if (problems.length === 0) return { quarantined: true, notes: [`quarantined until ${q.expiresAt} by ${q.reviewedBy}: ${q.reason}`] };
    notes.push(`quarantine for ${q.testId} ignored: ${problems.join(', ')}`);
  }
  return { quarantined: false, notes };
}

export interface FailingTest { testId: string; suite?: string | undefined; path?: string | undefined }

/** Failing tests become findings, except those under a valid, scoped, unexpired, reviewed quarantine, which are reported as informational. */
export function failureFindings(failing: readonly FailingTest[], entries: readonly QuarantineEntry[], environment: string, now: Date): TestFinding[] {
  return failing.map((f): TestFinding => {
    const q = activeQuarantine(entries, f, environment, now);
    return q.quarantined
      ? { id: `tests.quarantined-flaky:${f.testId}`, severity: 'info', title: `${f.testId} failed but is quarantined (${q.notes[0]})`, path: f.path }
      : { id: `tests.failing:${f.testId}`, severity: 'high', title: `${f.testId} failed${q.notes.length ? ` (${q.notes.join('; ')})` : ''}`, path: f.path };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

// ---- the provider -------------------------------------------------------------------------------------------------------------
export interface TestEffectivenessOptions {
  now: () => Date;
  environment: string;
  guard?: () => Promise<GuardResult>;
  testChanges?: () => Promise<readonly TestFileChange[]>;
  impacted?: () => Promise<{ impacted: readonly string[]; runs: readonly SuiteRun[] }>;
  failing?: () => Promise<readonly FailingTest[]>;
  quarantine?: readonly QuarantineEntry[];
  coverage?: () => Promise<{ changed: Readonly<Record<string, readonly number[]>>; covered: Readonly<Record<string, readonly number[]>> | undefined; minPercent: number } | undefined>;
}

export function testEffectivenessPlugin(opts: TestEffectivenessOptions): CheckProviderPlugin {
  return {
    async run(): Promise<PluginRunOutput> {
      const [guard, changes, imp, failing, cov] = await Promise.all([opts.guard?.(), opts.testChanges?.(), opts.impacted?.(), opts.failing?.(), opts.coverage?.()]);
      const findings: TestFinding[] = [
        ...(guard ? parseWeakeningGuard(guard) : []),
        ...(changes ? analyzeTestChanges(changes) : []),
        ...failureFindings(failing ?? [], opts.quarantine ?? [], opts.environment, opts.now()),
        ...(cov ? changedLineCoverage(cov.changed, cov.covered, cov.minPercent) : []),
      ];
      const missing = imp ? unexecutedImpacted(imp.impacted, imp.runs) : [];
      for (const id of missing) findings.push({ id: `tests.unexecuted-impacted:${id}`, severity: 'low', title: `impacted suite ${id} did not execute` });
      return {
        format: 'json', noFeed: true,
        document: { findings: findings.map((f) => ({ id: f.id, severity: f.severity, title: f.title, path: f.path, line: f.line })) },
        ...(missing.length ? { unknown: `impacted suite(s) did not execute: ${missing.join(', ')}` } : {}),
      };
    },
  };
}
