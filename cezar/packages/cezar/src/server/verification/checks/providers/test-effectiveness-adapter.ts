import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CheckProviderPlugin, PluginRunOutput } from '../check-runner.js';

/**
 * Test-effectiveness provider (#671) behind the check-provider contract (category `test`). It wraps the existing
 * weakening guard (scripts/check-weakening.ps1, exit 0/1/2) and consumes #53 impact selection, execution results,
 * quarantine entries and #54 baselines as injected input; it never spawns a process or selects tests itself.
 * Coverage trend is #649 and is not duplicated: only an optional changed-line figure is accepted.
 */

export const MAX_QUARANTINE_DAYS = 30;

export const quarantineEntrySchema = z.object({
  testId: z.string().min(1).max(512),
  environmentKey: z.string().min(1).max(256),
  /** Required: a quarantine without an expiry never ends (#651). */
  expiresAt: z.string().datetime(),
  reviewer: z.string().min(1).max(128),
  createdAt: z.string().datetime(),
  reason: z.string().max(500).optional(),
}).strict();
export type QuarantineEntry = z.infer<typeof quarantineEntrySchema>;

export interface TestFailure { testId: string; environmentKey: string; message?: string }
export interface WeakeningExecResult { exitCode: number; stderr: string; stdout?: string }
export interface CoverageInput { coveredChangedLines: number; totalChangedLines: number }

export interface TestEffectivenessInputs {
  /** Result of running the weakening guard against the change. */
  weakening: WeakeningExecResult;
  /** Suites selected by #53 impact selection, and those that actually executed. */
  selectedSuites: readonly string[];
  executedSuites: readonly string[];
  failures: readonly TestFailure[];
  /** Raw quarantine entries; invalid ones are ignored (fail closed) and reported. */
  quarantine: readonly unknown[];
  /** #54 baseline reference per environment key (e.g. a baseline id or digest). */
  baselines: Readonly<Record<string, string>>;
  coverage?: CoverageInput;
}

export interface TestEffectivenessOptions {
  collect: (signal: AbortSignal) => Promise<TestEffectivenessInputs>;
  now: () => Date;
  /** Minimum changed-line coverage percent; omit to only record it. */
  minChangedLineCoverage?: number;
  /** When true, a missing coverage artifact yields unknown instead of being ignored. */
  requireCoverage?: boolean;
}

export type QuarantineDecision = { active: true } | { active: false; reason: string };

/** Fail closed: anything not provably scoped, reviewed, unexpired and bounded is not quarantined. */
export function evaluateQuarantine(raw: unknown, failure: TestFailure, now: Date): QuarantineDecision {
  const parsed = quarantineEntrySchema.safeParse(raw);
  if (!parsed.success) return { active: false, reason: 'invalid quarantine entry' };
  const q = parsed.data;
  if (q.testId !== failure.testId || q.environmentKey !== failure.environmentKey) return { active: false, reason: 'scope mismatch' };
  const expires = Date.parse(q.expiresAt);
  if (!(expires > now.getTime())) return { active: false, reason: 'quarantine expired' };
  if (expires - Date.parse(q.createdAt) > MAX_QUARANTINE_DAYS * 86_400_000) return { active: false, reason: 'quarantine exceeds maximum duration' };
  return { active: true };
}

const short = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 10);

type Kind = 'deletion' | 'skip' | 'assertion' | 'other';
function classify(msg: string): Kind {
  const m = msg.toLowerCase();
  if (/\b(delet|remov)/.test(m)) return 'deletion';
  if (/\b(skip|disabled?|ignore|xfail|pending)/.test(m)) return 'skip';
  if (/\b(assert|expect|threshold|weaken|loosen)/.test(m)) return 'assertion';
  return 'other';
}

/** Violations are the `  - message` lines the guard writes to stderr. */
export function parseWeakeningViolations(stderr: string): string[] {
  return stderr.split(/\r?\n/).map((l) => /^\s*-\s+(.+)$/.exec(l)?.[1]?.trim()).filter((l): l is string => Boolean(l));
}

type F = Record<string, unknown>;

export function testEffectivenessPlugin(opts: TestEffectivenessOptions): CheckProviderPlugin {
  return {
    async run({ signal }): Promise<PluginRunOutput> {
      const input = await opts.collect(signal);
      const w = input.weakening;
      if (w.exitCode === 2) throw new Error('weakening guard failed closed (exit 2)');
      if (w.exitCode !== 0 && w.exitCode !== 1) throw new Error(`weakening guard exited with code ${w.exitCode}`);
      const violations = parseWeakeningViolations(w.stderr);
      if (w.exitCode === 1 && !violations.length) throw new Error('weakening guard reported violations in an unrecognized format');

      const findings: F[] = [];
      const baselineRef = (env: string) => (input.baselines[env] ? `baseline:${env}:${input.baselines[env]}` : `baseline:${env}:missing`);

      for (const v of violations) {
        const kind = classify(v);
        findings.push({
          id: `test-weakening.${kind}`, severity: 'high', title: v, path: `weakening/${short(v)}`,
          fingerprint: `weakening|${short(v)}`, references: [],
        });
      }

      const executed = new Set(input.executedSuites);
      const missing = input.selectedSuites.filter((s) => !executed.has(s)).sort();

      const now = opts.now();
      for (const f of input.failures) {
        const decisions = input.quarantine.map((q) => evaluateQuarantine(q, f, now));
        const quarantined = decisions.some((d) => d.active);
        findings.push({
          id: quarantined ? 'test-failure.quarantined' : 'test-failure', severity: quarantined ? 'medium' : 'high',
          title: `${f.testId} failed in ${f.environmentKey}${quarantined ? ' (quarantined until expiry)' : ''}${f.message ? `: ${f.message}` : ''}`,
          path: f.testId, fingerprint: `failure|${f.testId}|${f.environmentKey}`, references: [baselineRef(f.environmentKey)],
        });
      }

      if (input.coverage) {
        const { coveredChangedLines: c, totalChangedLines: t } = input.coverage;
        const pct = t > 0 ? (100 * c) / t : 100;
        if (opts.minChangedLineCoverage !== undefined && pct < opts.minChangedLineCoverage) {
          findings.push({ id: 'changed-line-coverage', severity: 'medium', title: `changed-line coverage ${pct.toFixed(1)}% is below ${opts.minChangedLineCoverage}%`, path: 'coverage/changed-lines', fingerprint: 'coverage|changed-lines', references: [] });
        }
      }

      for (const s of missing) {
        findings.push({ id: 'impacted-suite-not-run', severity: 'medium', title: `impacted suite ${s} was selected but not executed`, path: s, fingerprint: `not-run|${s}`, references: [] });
      }

      const common = { document: { findings }, format: 'json' as const };
      const noFindings = findings.length === 0;
      if (noFindings && opts.requireCoverage && !input.coverage) return { ...common, notApplicable: 'not-run: no changed-line coverage artifact supplied' };
      if (missing.length && !findings.some((f) => f.id !== 'impacted-suite-not-run')) return { ...common, notApplicable: `not-run: impacted suites not executed (${missing.join(', ')})` };
      return common;
    },
  };
}
