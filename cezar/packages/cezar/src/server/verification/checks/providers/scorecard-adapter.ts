import { z } from 'zod';
import { checkProviderConfigSchema, type CheckDefinition } from '../check-provider.js';
import type { CheckProviderPlugin, PluginRunOutput } from '../check-runner.js';

/**
 * Opt-in periodic OpenSSF Scorecard (#654), report-only. It is disabled by default. A result is recorded with provenance but can
 * never block a release: findings are capped at `info`/`low` severity, so a run is at worst `warn`. Scorecard's own checks may
 * assume a GitHub-hosted setup, which is exactly why it informs and never gates. It needs network egress to its data sources, which
 * the isolated scanner profile (`docs/scanner-worker-profile.md`) must allow explicitly for this phase; nothing here widens it.
 */

export const scorecardConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** How often the independent schedule runs it. */
  cadence: z.enum(['weekly', 'monthly']).default('monthly'),
  timezone: z.string().min(1).max(64).default('UTC'),
  /** Checks scoring below this are listed as low-severity observations; none can block. */
  observeBelow: z.number().min(0).max(10).default(5),
}).strict();
export type ScorecardConfig = z.infer<typeof scorecardConfigSchema>;

const reportSchema = z.object({
  date: z.string().optional(),
  repo: z.object({ name: z.string().min(1), commit: z.string().optional() }).passthrough(),
  scorecard: z.object({ version: z.string().optional(), commit: z.string().optional() }).passthrough().optional(),
  score: z.number().min(-1).max(10),
  checks: z.array(z.object({ name: z.string().min(1), score: z.number().min(-1).max(10), reason: z.string().optional() }).passthrough()),
}).passthrough();

export interface ScorecardRecord {
  repo: string;
  commit: string | undefined;
  score: number;
  scorecardVersion: string | undefined;
  ranAt: string | undefined;
  lowChecks: Array<{ name: string; score: number }>;
}

/** Parse a Scorecard JSON report into a record with provenance. A score of -1 means "could not evaluate", not a failure. */
export function parseScorecard(json: string, config: ScorecardConfig): { record: ScorecardRecord; findings: Array<Record<string, unknown>> } {
  const r = reportSchema.safeParse(JSON.parse(json));
  if (!r.success) throw new Error(`unrecognized Scorecard report: ${r.error.issues.slice(0, 2).map((i) => i.path.join('.')).join(', ')}`);
  const lowChecks = r.data.checks.filter((c) => c.score >= 0 && c.score < config.observeBelow).map((c) => ({ name: c.name, score: c.score }));
  return {
    record: { repo: r.data.repo.name, commit: r.data.repo.commit, score: r.data.score, scorecardVersion: r.data.scorecard?.version, ranAt: r.data.date, lowChecks },
    // Capped at `low`: report-only means no finding from this provider can ever reach a blocking severity.
    findings: lowChecks.map((c) => ({ id: `scorecard.${c.name.toLowerCase()}`, severity: 'low', title: `Scorecard ${c.name} scored ${c.score}/10`, path: undefined })),
  };
}

export function buildScorecardArgv(repo: string): string[] {
  return ['scorecard', `--repo=${repo}`, '--format=json'];
}

export interface ScorecardPluginOptions {
  config: ScorecardConfig;
  repo: string;
  exec: (argv: string[], signal: AbortSignal) => Promise<{ exitCode: number; stdout: string }>;
  onRecord?: (record: ScorecardRecord) => void;
}

/** Disabled (the default) makes zero scorecard calls and reports not-applicable with the reason. */
export function scorecardPlugin(opts: ScorecardPluginOptions): CheckProviderPlugin {
  return {
    async run({ signal }): Promise<PluginRunOutput> {
      if (!opts.config.enabled) return { format: 'json', document: { findings: [] }, notApplicable: 'OpenSSF Scorecard is disabled (opt-in)' };
      const res = await opts.exec(buildScorecardArgv(opts.repo), signal);
      if (res.exitCode !== 0) throw new Error(`scorecard exited with code ${res.exitCode}`);
      const { record, findings } = parseScorecard(res.stdout, opts.config);
      opts.onRecord?.(record);
      return { format: 'json', document: { findings }, noFeed: true };
    },
  };
}

/** The independent-schedule entry for the periodic check: advisory, never mandatory, no effect on any candidate. */
export function scorecardCheckDefinition(config: ScorecardConfig, provider: { version: string; digest: string }): CheckDefinition {
  if (!config.enabled) throw new Error('scorecard is disabled; there is no schedule entry to create');
  return checkProviderConfigSchema.parse({ version: 1, checks: [{
    id: 'openssf-scorecard', category: 'custom', provider: { name: 'scorecard', ...provider }, scopes: ['full-repo'], triggers: ['periodic-independent', 'manual'],
    schedule: { cron: config.cadence === 'weekly' ? '0 3 * * 1' : '0 3 1 * *', timezone: config.timezone },
    policy: { mandatory: false, timeoutMs: 600_000, onFailure: 'unknown', onFeedUnavailable: 'unknown', maxAgeHours: config.cadence === 'weekly' ? 24 * 8 : 24 * 32, cache: { enabled: true, ttlHours: 24 } },
  }] }).checks[0]!;
}
