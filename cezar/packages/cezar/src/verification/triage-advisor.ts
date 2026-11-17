import { z } from 'zod';
import type { StageDecision } from './disposition-rules.ts';

/**
 * Optional local-model triage advisor for verification findings (#667). It offers advice (semantic duplicates, causal hypotheses,
 * test-obsolescence hypotheses, suggested follow-ups) as extra input next to a disposition record. It is advisory by construction:
 *
 * - it is off by default and uses a local model only (a loopback or private-network endpoint);
 * - the stage decision is never an input it can change: `triage` returns the original decision untouched and the advice separately,
 *   so advice cannot turn a BLOCK into CONTINUE, waive a mandatory check, change policy or approve anything;
 * - every claim must cite evidence the decision actually has, or it is dropped;
 * - a disabled, failing, malformed or over-budget advisor degrades to no advice and the dispositions are exactly what they were.
 */

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+\.local)$/i;

export function isLocalEndpoint(endpoint: string): boolean {
  try { return LOCAL_HOST.test(new URL(endpoint).hostname); } catch { return false; }
}

export const triageConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** A local model endpoint. A remote host makes the configuration invalid (no code or findings leave the network). */
  endpoint: z.string().url().refine(isLocalEndpoint, 'the triage advisor may only use a local model endpoint').optional(),
  budget: z.object({
    maxCalls: z.number().int().min(1).max(10).default(1),
    maxTokens: z.number().int().min(100).max(200_000).default(8_000),
    maxCostUnits: z.number().min(0).max(1_000).default(0),
  }).strict().default(() => ({ maxCalls: 1, maxTokens: 8_000, maxCostUnits: 0 })),
}).strict().superRefine((c, ctx) => {
  if (c.enabled && !c.endpoint) ctx.addIssue({ code: 'custom', path: ['endpoint'], message: 'an enabled advisor needs a local endpoint' });
});
export type TriageConfig = z.infer<typeof triageConfigSchema>;

export const ADVICE_KINDS = ['duplicate-of', 'cause', 'test-obsolete', 'follow-up'] as const;
export interface Advice { fingerprint: string; kind: (typeof ADVICE_KINDS)[number]; claim: string; evidenceRefs: string[] }

/** What the advisor sees: identifiers, severities and rule ids only. Raw evidence and secrets are never passed. */
export interface AdvisorInput {
  stage: string;
  findings: Array<{ fingerprint: string; checkId: string; decision: string; ruleId: string | null }>;
  maxTokens: number;
}
export interface AdvisorOutput { advice: unknown[]; tokens: number; costUnits: number }
export type Advisor = (input: AdvisorInput) => Promise<AdvisorOutput>;

export type TriageStatus = 'disabled' | 'invalid-config' | 'ok' | 'failed' | 'budget-exceeded' | 'no-valid-advice';
export interface TriageResult {
  /** The very same decision that went in. Advice never modifies it. */
  decision: StageDecision;
  advice: Advice[];
  status: TriageStatus;
  /** Advice items dropped for missing or unknown evidence, an unknown kind or an unknown finding. */
  rejected: number;
  llmCalls: number;
}

export async function triage(rawConfig: unknown, decision: StageDecision, advisor: Advisor): Promise<TriageResult> {
  const parsed = triageConfigSchema.safeParse(rawConfig ?? {});
  if (!parsed.success) return { decision, advice: [], status: 'invalid-config', rejected: 0, llmCalls: 0 };
  const cfg = parsed.data;
  if (!cfg.enabled) return { decision, advice: [], status: 'disabled', rejected: 0, llmCalls: 0 };

  const findings = decision.decisions.filter((d) => d.fingerprint).map((d) => ({ fingerprint: d.fingerprint as string, checkId: d.checkId, decision: String(d.decision), ruleId: d.ruleId }));
  if (findings.length === 0) return { decision, advice: [], status: 'ok', rejected: 0, llmCalls: 0 };

  let out: AdvisorOutput;
  try {
    out = await advisor({ stage: decision.stage, findings, maxTokens: cfg.budget.maxTokens });
  } catch {
    return { decision, advice: [], status: 'failed', rejected: 0, llmCalls: 1 };
  }
  if (!out || typeof out.tokens !== 'number' || out.tokens > cfg.budget.maxTokens || out.costUnits > cfg.budget.maxCostUnits || !Array.isArray(out.advice)) {
    return { decision, advice: [], status: 'budget-exceeded', rejected: 0, llmCalls: 1 };
  }

  const known = new Set(findings.map((f) => f.fingerprint));
  const evidence = new Set([...findings.flatMap((f) => [f.fingerprint, f.checkId, ...(f.ruleId ? [f.ruleId] : [])]), decision.stage]);
  const advice: Advice[] = [];
  let rejected = 0;
  for (const raw of out.advice) {
    const a = raw as Partial<Advice> | null;
    const valid = a && typeof a.fingerprint === 'string' && known.has(a.fingerprint) && (ADVICE_KINDS as readonly string[]).includes(a.kind as string)
      && typeof a.claim === 'string' && a.claim.length > 0 && a.claim.length <= 500
      && Array.isArray(a.evidenceRefs) && a.evidenceRefs.length > 0 && a.evidenceRefs.every((r) => typeof r === 'string' && evidence.has(r));
    if (valid) advice.push({ fingerprint: a!.fingerprint!, kind: a!.kind!, claim: a!.claim!, evidenceRefs: [...a!.evidenceRefs!] });
    else rejected++;
  }
  return { decision, advice, status: advice.length > 0 || out.advice.length === 0 ? 'ok' : 'no-valid-advice', rejected, llmCalls: 1 };
}
