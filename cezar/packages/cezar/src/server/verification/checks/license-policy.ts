import { z } from 'zod';
import type { CheckProviderPlugin, PluginRunOutput } from './check-runner.js';
import type { SbomComponent } from './sbom.js';

/**
 * Source and dependency license policy (#652): allow, deny and review lists over SPDX identifiers and expressions, with explicit
 * unknown-license handling. Output is the generic findings document for the `license` category: a denied license is a blocking
 * finding, a license needing review or an unknown one is a non-blocking finding by default (policy can make unknown block).
 */

export const licensePolicySchema = z.object({
  allow: z.array(z.string().min(1)).max(500).default([]),
  deny: z.array(z.string().min(1)).max(500).default([]),
  review: z.array(z.string().min(1)).max(500).default([]),
  /** What a missing or unparseable license means. `allow` is not offered: unknown is never silently fine. */
  unknown: z.enum(['review', 'deny']).default('review'),
  /** Per-package exceptions: reviewed, named and bounded to one package. */
  exceptions: z.array(z.object({ package: z.string().min(1), license: z.string().min(1), reason: z.string().min(1).max(300), expiresAt: z.string().datetime() }).strict()).max(200).default([]),
}).strict().superRefine((p, ctx) => {
  const seen = new Map<string, string>();
  for (const [list, ids] of [['allow', p.allow], ['deny', p.deny], ['review', p.review]] as const) {
    for (const id of ids) {
      const prior = seen.get(id.toLowerCase());
      if (prior && prior !== list) ctx.addIssue({ code: 'custom', path: [list], message: `${id} is in both ${prior} and ${list}` });
      seen.set(id.toLowerCase(), list);
    }
  }
});
export type LicensePolicy = z.infer<typeof licensePolicySchema>;

export type LicenseVerdict = 'allowed' | 'denied' | 'review' | 'unknown';

/** Tokenize and evaluate an SPDX expression: `OR` takes the best option, `AND` the worst, `WITH` exceptions are ignored for the id. */
export function evaluateExpression(expr: string, policy: LicensePolicy): LicenseVerdict {
  const tokens = expr.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').trim().split(/\s+/).filter(Boolean);
  let i = 0;
  const rank: Record<LicenseVerdict, number> = { allowed: 0, review: 1, unknown: 2, denied: 3 };
  const worst = (a: LicenseVerdict, b: LicenseVerdict) => (rank[a] >= rank[b] ? a : b);
  const best = (a: LicenseVerdict, b: LicenseVerdict) => (rank[a] <= rank[b] ? a : b);
  const atom = (): LicenseVerdict => {
    const t = tokens[i++];
    if (t === undefined) return 'unknown';
    if (t === '(') { const v = or(); if (tokens[i] === ')') i++; return v; }
    if (tokens[i]?.toUpperCase() === 'WITH') i += 2; // exception clause does not change the base license verdict
    return idVerdict(t.replace(/\+$/, ''), policy);
  };
  const and = (): LicenseVerdict => { let v = atom(); while (tokens[i]?.toUpperCase() === 'AND') { i++; v = worst(v, atom()); } return v; };
  const or = (): LicenseVerdict => { let v = and(); while (tokens[i]?.toUpperCase() === 'OR') { i++; v = best(v, and()); } return v; };
  const result = or();
  return i < tokens.length ? 'unknown' : result; // trailing garbage means we did not understand it
}

function idVerdict(id: string, p: LicensePolicy): LicenseVerdict {
  const k = id.toLowerCase();
  if (p.deny.some((d) => d.toLowerCase() === k)) return 'denied';
  if (p.allow.some((a) => a.toLowerCase() === k)) return 'allowed';
  if (p.review.some((r) => r.toLowerCase() === k)) return 'review';
  return 'unknown';
}

export interface LicenseFinding { id: string; severity: string; package: string; version?: string | undefined; title: string; path?: string }

/** Evaluate components against the policy. Returns the generic findings document for the shared normalizer. */
export function licenseFindings(components: readonly SbomComponent[], policy: LicensePolicy, now: Date): { findings: LicenseFinding[]; summary: Record<LicenseVerdict, number> } {
  const summary: Record<LicenseVerdict, number> = { allowed: 0, denied: 0, review: 0, unknown: 0 };
  const findings: LicenseFinding[] = [];
  for (const c of components) {
    let verdict: LicenseVerdict = c.license ? evaluateExpression(c.license, policy) : 'unknown';
    const exception = policy.exceptions.find((e) => e.package === c.name && c.license !== undefined && e.license.toLowerCase() === c.license.toLowerCase() && Date.parse(e.expiresAt) > now.getTime());
    if (exception && verdict !== 'allowed') verdict = 'allowed';
    summary[verdict]++;
    if (verdict === 'allowed') continue;
    const lic = c.license ?? 'no license declared';
    const effective: LicenseVerdict = verdict === 'unknown' && policy.unknown === 'deny' ? 'denied' : verdict;
    const severity = effective === 'denied' ? 'high' : effective === 'review' ? 'medium' : 'low';
    findings.push({ id: `license:${(c.license ?? 'unknown').toLowerCase()}`, severity, package: c.name, version: c.version,
      title: effective === 'denied' ? `denied license ${lic} in ${c.name}` : effective === 'review' ? `license ${lic} in ${c.name} needs review` : `unknown license for ${c.name}` });
  }
  return { findings, summary };
}

export interface LicensePluginOptions {
  policy: LicensePolicy;
  /** The validated SBOM components for the candidate SHA (see `sbom.ts`). */
  readComponents: () => Promise<readonly SbomComponent[]>;
  now?: () => Date;
}

export function licensePlugin(opts: LicensePluginOptions): CheckProviderPlugin {
  return {
    async run(): Promise<PluginRunOutput> {
      const components = await opts.readComponents();
      if (components.length === 0) return { format: 'json', document: { findings: [] }, notApplicable: 'the SBOM lists no components' };
      const { findings } = licenseFindings(components, opts.policy, (opts.now ?? (() => new Date()))());
      return { format: 'json', document: { findings } };
    },
  };
}
