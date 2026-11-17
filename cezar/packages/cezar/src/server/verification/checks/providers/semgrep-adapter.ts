import { createHash } from 'node:crypto';
import type { CheckProviderPlugin, PluginRunOutput } from '../check-runner.js';

/**
 * Semgrep Community SAST adapter (#647) behind the check-provider contract. Rulesets are pinned by digest: a ruleset that is
 * unavailable or whose digest differs from its pin is an error (never a pass), and the combined ruleset digest is part of the
 * cache key and the provenance, so changing a ruleset misses the cache. `exec` runs the argv in the isolated scanner worker (#605).
 */

export interface RulesetSource {
  id: string;
  /** Where the worker reads the rules (a local path or a pinned registry reference). Never fetched at scan time. */
  path: string;
  /** `sha256:<64 hex>` of the ruleset contents, recorded when the ruleset was reviewed. */
  digest: string;
}

export function rulesetDigest(rulesets: readonly RulesetSource[]): string {
  const list = rulesets.map((r) => `${r.id}@${r.digest}`).sort();
  return `sha256:${createHash('sha256').update(list.join('\n')).digest('hex')}`;
}

export function buildSemgrepArgv(i: { target: string; rulesets: readonly RulesetSource[] }): string[] {
  if (!i.rulesets.length) throw new Error('at least one pinned ruleset is required; semgrep never runs with its default registry rules');
  return ['semgrep', 'scan', '--sarif', '--metrics=off', '--disable-version-check', '--quiet',
    ...i.rulesets.flatMap((r) => ['--config', r.path]), '--', i.target];
}

export interface SemgrepExecResult { exitCode: number; stdout: string }

export interface SemgrepPluginOptions {
  target: string;
  rulesets: readonly RulesetSource[];
  exec: (argv: string[], signal: AbortSignal) => Promise<SemgrepExecResult>;
  /** Digest of the ruleset as it exists on the worker now, or undefined if it cannot be read. */
  readRulesetDigest: (source: RulesetSource) => Promise<string | undefined>;
  /** How many files in the target use a language the pinned rulesets support. Zero means there is nothing to analyse. */
  countSupportedFiles: () => Promise<number>;
  observed?: () => Promise<NonNullable<PluginRunOutput['observed']>>;
}

export function semgrepPlugin(opts: SemgrepPluginOptions): CheckProviderPlugin {
  const pinned = rulesetDigest(opts.rulesets);
  return {
    probe: async () => ({ inputsDigest: pinned }),
    async run({ signal }): Promise<PluginRunOutput> {
      for (const r of opts.rulesets) {
        const actual = await opts.readRulesetDigest(r);
        if (actual === undefined) throw new Error(`ruleset ${r.id} is unavailable`);
        if (actual !== r.digest) throw new Error(`ruleset ${r.id} digest ${actual} does not match its pin ${r.digest}`);
      }
      const common = { inputsDigest: pinned, observed: await opts.observed?.() };
      if ((await opts.countSupportedFiles()) === 0) {
        return { format: 'sarif', document: { runs: [] }, notApplicable: 'no files in a language the pinned rulesets support', ...common };
      }
      const res = await opts.exec(buildSemgrepArgv({ target: opts.target, rulesets: opts.rulesets }), signal);
      // Semgrep exits 0 (clean) or 1 (findings, when asked); anything else is a failure, not a result.
      if (res.exitCode !== 0 && res.exitCode !== 1) throw new Error(`semgrep exited with code ${res.exitCode}`);
      let document: unknown;
      try { document = JSON.parse(res.stdout); } catch { throw new Error('semgrep produced non-JSON output'); }
      return { format: 'sarif', document, ...common };
    },
  };
}
