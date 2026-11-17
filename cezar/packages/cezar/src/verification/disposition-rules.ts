import { z } from 'zod';
import { DISPOSITIONS, type Disposition, type DispositionResult, type RunDisposition } from './disposition.ts';

/**
 * Deterministic disposition rules and stage minimum gates (#665). Normalized dispositions map to CONTINUE, RECORD (follow-up),
 * RETRY (repair or rerun) or BLOCK per stage, instead of "nonzero exit means failure". The policy is data in
 * `policies/verification.json` (`dispositionRules`), validated by the schema below. It is a protected asset: an implementation
 * change cannot edit it (`policyEditViolations`).
 *
 * First matching rule wins; with no match the stage's `default` for that disposition applies; anything unmatched and unknown is
 * conservative (RECORD at worst, never a silent CONTINUE for an unusable run).
 */

export const ACTIONS = ['CONTINUE', 'RECORD', 'RETRY', 'BLOCK'] as const;
export type Action = (typeof ACTIONS)[number];
const SEV = ['info', 'low', 'medium', 'high', 'critical'] as const;
const sevRank = (s: string): number => Math.max(0, SEV.indexOf(s as (typeof SEV)[number]));
const ACTION_RANK: Record<Action, number> = { CONTINUE: 0, RECORD: 1, RETRY: 2, BLOCK: 3 };

const dispositionEnum = z.enum(DISPOSITIONS);
export const ruleSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  when: z.object({
    decision: z.array(dispositionEnum).min(1).optional(),
    class: z.enum(['security', 'quality-debt']).optional(),
    minSeverity: z.enum(SEV).optional(),
    /** Only findings in the impacted scope of the change. */
    impacted: z.boolean().optional(),
    category: z.array(z.string().min(1)).min(1).optional(),
  }).strict(),
  action: z.enum(ACTIONS),
  reason: z.string().min(1).max(300),
}).strict();

export const stagePolicySchema = z.object({
  /** Check ids that must have a usable (compared) run at this stage; otherwise the stage cannot continue. */
  requiredChecks: z.array(z.string().min(1)).max(100).default([]),
  /** Disposition used when no rule matches. */
  default: z.partialRecord(dispositionEnum, z.enum(ACTIONS)).default(() => ({})),
  rules: z.array(ruleSchema).max(100).default([]),
  /** A scanner or runner outage is retried this many times, then escalates to BLOCK. */
  maxRetries: z.number().int().min(0).max(10).default(2),
}).strict();

export const dispositionPolicySchema = z.object({
  version: z.string().min(1).max(64),
  stages: z.record(z.string().min(1).max(64), stagePolicySchema),
}).strict().superRefine((p, ctx) => {
  for (const [stage, s] of Object.entries(p.stages)) {
    const seen = new Set<string>();
    s.rules.forEach((r, i) => {
      if (seen.has(r.id)) ctx.addIssue({ code: 'custom', path: ['stages', stage, 'rules', i, 'id'], message: `duplicate rule id ${r.id}` });
      seen.add(r.id);
    });
    // Safety floor: an unusable run can never be configured to continue silently.
    for (const d of ['unknown', 'untested', 'infra-failure'] as const) {
      const configured = s.default[d];
      if (configured === 'CONTINUE') ctx.addIssue({ code: 'custom', path: ['stages', stage, 'default', d], message: `${d} must not default to CONTINUE` });
    }
    s.rules.forEach((r, i) => {
      if (r.action === 'CONTINUE' && r.when.decision?.some((d) => d === 'unknown' || d === 'untested' || d === 'infra-failure')) {
        ctx.addIssue({ code: 'custom', path: ['stages', stage, 'rules', i, 'action'], message: 'a rule cannot CONTINUE past an unusable run (unknown, untested, infra-failure)' });
      }
    });
  }
});
export type DispositionPolicy = z.infer<typeof dispositionPolicySchema>;
export type StagePolicy = z.infer<typeof stagePolicySchema>;

export function dispositionPolicyJsonSchema(): unknown {
  return z.toJSONSchema(dispositionPolicySchema);
}

/** Built-in defaults used when a stage names no rule for a disposition. */
export const BUILTIN_DEFAULTS: Record<Disposition, Action> = {
  known: 'CONTINUE', resolved: 'CONTINUE', new: 'RECORD', worsened: 'RECORD', reopened: 'RECORD', untested: 'RECORD', unknown: 'RECORD', 'infra-failure': 'RETRY',
};

export interface FindingFacts { class: 'security' | 'quality-debt'; severity: string; impacted: boolean; category?: string }

export interface CheckRun {
  checkId: string;
  result: DispositionResult;
  /** Facts about each present or recorded finding, by fingerprint (class, impact), supplied by the caller. */
  facts: Record<string, FindingFacts>;
  /** How many times this check has already been retried for the same run. */
  attempts: number;
}

export interface Decision { fingerprint: string | null; checkId: string; decision: Disposition | RunDisposition; action: Action; ruleId: string | null; reason: string }
export interface StageDecision {
  stage: string;
  action: Action;
  blocked: boolean;
  escalated: string[];
  decisions: Decision[];
  followUps: string[];
  retry: string[];
  summary: string;
  /** Rows for the existing Operations/Verification views. */
  rows: Array<{ checkId: string; run: RunDisposition; counts: Record<string, number>; action: Action }>;
}

const worse = (a: Action, b: Action): Action => (ACTION_RANK[a] >= ACTION_RANK[b] ? a : b);

function matches(rule: z.infer<typeof ruleSchema>, decision: Disposition, facts: FindingFacts | undefined, checkId: string): boolean {
  const w = rule.when;
  if (w.decision && !w.decision.includes(decision)) return false;
  if (w.class && facts?.class !== w.class) return false;
  if (w.minSeverity && sevRank(facts?.severity ?? 'info') < sevRank(w.minSeverity)) return false;
  if (w.impacted !== undefined && Boolean(facts?.impacted) !== w.impacted) return false;
  if (w.category && !w.category.includes(facts?.category ?? checkId)) return false;
  return true;
}

export function decideStage(policy: DispositionPolicy, stage: string, runs: readonly CheckRun[]): StageDecision {
  const sp = policy.stages[stage];
  if (!sp) throw new Error(`no disposition policy for stage ${stage}`);
  const decisions: Decision[] = [];
  const escalated: string[] = [];
  const rows: StageDecision['rows'] = [];
  let overall: Action = 'CONTINUE';
  const byCheck = new Map(runs.map((r) => [r.checkId, r]));

  // Stage minimum gate: a required check with no usable run stays unusable, never a pass.
  for (const id of sp.requiredChecks) {
    const r = byCheck.get(id);
    if (!r) {
      decisions.push({ fingerprint: null, checkId: id, decision: 'untested', action: 'BLOCK', ruleId: 'stage-minimum', reason: `required check ${id} did not run at this stage` });
      overall = worse(overall, 'BLOCK');
    }
  }

  for (const r of runs) {
    let checkAction: Action = 'CONTINUE';
    const usable = r.result.run === 'compared';
    if (!usable) {
      const required = sp.requiredChecks.includes(r.checkId);
      const isOutage = r.result.run === 'infra-failure';
      let action: Action;
      let reason: string;
      if (isOutage) {
        const exhausted = r.attempts >= sp.maxRetries;
        action = exhausted ? 'BLOCK' : 'RETRY';
        reason = exhausted ? `outage persisted after ${r.attempts} retries; escalating` : `outage; retry ${r.attempts + 1} of ${sp.maxRetries}`;
        if (exhausted) escalated.push(r.checkId);
      } else {
        action = required ? 'BLOCK' : (sp.default[r.result.run === 'untrusted-baseline' ? 'new' : (r.result.run as Disposition)] ?? 'RECORD');
        if (action === 'CONTINUE') action = 'RECORD';
        reason = required ? `required check is ${r.result.run}` : `${r.result.run}; recorded, not a pass`;
      }
      // An untrusted baseline still lets individual `new` findings be evaluated below; the run-level note is informational.
      if (r.result.run !== 'untrusted-baseline') {
        decisions.push({ fingerprint: null, checkId: r.checkId, decision: r.result.run, action, ruleId: 'run-level', reason });
        checkAction = worse(checkAction, action);
      }
    }
    for (const rec of r.result.records) {
      const facts = r.facts[rec.fingerprint];
      const rule = sp.rules.find((x) => matches(x, rec.decision, facts, r.checkId));
      const action = rule ? rule.action : (sp.default[rec.decision] ?? BUILTIN_DEFAULTS[rec.decision]);
      decisions.push({ fingerprint: rec.fingerprint, checkId: r.checkId, decision: rec.decision, action, ruleId: rule?.id ?? null, reason: rule?.reason ?? `default for ${rec.decision}` });
      checkAction = worse(checkAction, action);
    }
    rows.push({ checkId: r.checkId, run: r.result.run, counts: r.result.summary as Record<string, number>, action: checkAction });
    overall = worse(overall, checkAction);
  }

  const followUps = [...new Set(decisions.filter((d) => d.action === 'RECORD' && d.fingerprint).map((d) => d.fingerprint as string))].sort();
  const retry = [...new Set(decisions.filter((d) => d.action === 'RETRY').map((d) => d.checkId))].sort();
  const blocking = decisions.filter((d) => d.action === 'BLOCK');
  const summary = [
    `${overall} at ${stage}`,
    blocking.length ? `blocking: ${blocking.slice(0, 5).map((d) => `${d.checkId}${d.fingerprint ? `:${d.fingerprint.slice(0, 8)}` : ''} (${d.reason})`).join('; ')}${blocking.length > 5 ? `; +${blocking.length - 5} more` : ''}` : null,
    retry.length ? `retry: ${retry.join(', ')}` : null,
    followUps.length ? `${followUps.length} follow-up(s) to record` : null,
  ].filter(Boolean).join(' | ');
  return { stage, action: overall, blocked: overall === 'BLOCK', escalated: [...new Set(escalated)], decisions, followUps, retry, summary, rows };
}

/** Paths an implementation change may not touch: the policy, baselines and waivers (`policies/protected-assets.json`). */
export function policyEditViolations(changedPaths: readonly string[], protectedGlobs: readonly string[]): string[] {
  const rx = protectedGlobs.map((g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0001/g, '(?:.*/)?').replace(/\u0000/g, '.*')}$`));
  return changedPaths.filter((p) => rx.some((r) => r.test(p.replace(/\\/g, '/'))));
}
