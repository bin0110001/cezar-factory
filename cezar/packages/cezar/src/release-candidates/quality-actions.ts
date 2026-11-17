import { appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  QUALITY_STAGES, type QualityDryRunRequest, type QualityDryRunResponse, type ReleaseCandidatesResponse, type WaiverRequest, type WaiverResponse,
} from '@open-mercato/cezar-contract';
import { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';
import { cezarHomeDir } from '../paths.ts';

/**
 * Quality actions for the Control Center (#603). `isBlocking`, `effective` and the stage matrix are a port of
 * `scripts/release/quality_gate_policy.py` (the authority the engine uses); `tests/fixtures/quality-gate-cases.json` is generated from the
 * Python library and checked by the TypeScript test, so a dry run agrees with what the gates will do.
 */

type J = Record<string, unknown>;
export const CATEGORIES = ['format', 'lint', 'type', 'test', 'sast', 'sca', 'secrets', 'iac', 'container', 'license', 'sbom', 'complexity', 'custom', 'ai-audit'] as const;
const SECURITY = new Set(['sast', 'sca', 'secrets', 'iac', 'container']);
const PROMOTION = new Set(['candidate', 'stable']);
const LEVELS = ['required', 'optional', 'advisory', 'off'];
const isObj = (v: unknown): v is J => typeof v === 'object' && v !== null && !Array.isArray(v);

function merge(base: unknown, over: unknown): unknown {
  if (isObj(base) && isObj(over)) {
    const out: J = structuredClone(base);
    for (const [k, v] of Object.entries(over)) out[k] = k in out ? merge(out[k], v) : structuredClone(v);
    return out;
  }
  return structuredClone(over);
}

export function effectivePolicy(doc: J, project: string | null, repoType: string | null): J {
  let eff = structuredClone((doc.defaults ?? {}) as J);
  if (repoType) eff = merge(eff, (isObj(doc.repoTypes) ? doc.repoTypes[repoType] : undefined) ?? {}) as J;
  if (project) eff = merge(eff, (isObj(doc.projects) ? doc.projects[project] : undefined) ?? {}) as J;
  return eff;
}

export interface Spec { level: 'required' | 'optional' | 'advisory' | 'off'; onUnavailable: 'fail-closed' | 'fail-open' }
export function specOf(eff: J, category: string, stage: string): Spec {
  const checks = isObj(eff.checks) ? eff.checks : {};
  const forCat = isObj(checks[category]) ? (checks[category] as J) : {};
  const raw = forCat[stage] ?? 'off';
  const spec: J = typeof raw === 'string' ? { level: raw } : { ...(raw as J) };
  const level = spec.level as Spec['level'];
  const onUnavailable = (spec.onUnavailable as Spec['onUnavailable'] | undefined) ?? (level === 'required' && SECURITY.has(category) && PROMOTION.has(stage) ? 'fail-closed' : 'fail-open');
  return { level, onUnavailable };
}

export function isBlocking(eff: J, category: string, stage: string, status: string): boolean {
  const s = specOf(eff, category, stage);
  if (s.level === 'off' || s.level === 'advisory') return false;
  if (status === 'pass' || status === 'warn' || status === 'not-applicable') return false;
  if (status === 'fail') return s.level === 'required';
  return s.level === 'required' && s.onUnavailable === 'fail-closed';
}

/** Light validation of the pieces a dry run depends on. The engine's validator is the authority for saving a policy. */
export function validateQualityPolicy(doc: J): string[] {
  const errors: string[] = [];
  if (doc.schemaVersion !== 'quality-gates/v1') errors.push(`schemaVersion: expected 'quality-gates/v1', got ${JSON.stringify(doc.schemaVersion)}`);
  if (!isObj(doc.defaults)) { errors.push('defaults: required'); return errors; }
  const layers: Array<[string, unknown]> = [['defaults', doc.defaults], ...Object.entries(isObj(doc.repoTypes) ? doc.repoTypes : {}).map(([k, v]) => [`repoTypes.${k}`, v] as [string, unknown]), ...Object.entries(isObj(doc.projects) ? doc.projects : {}).map(([k, v]) => [`projects.${k}`, v] as [string, unknown])];
  for (const [where, layer] of layers) {
    if (!isObj(layer)) { errors.push(`${where}: must be an object`); continue; }
    for (const [cat, stages] of Object.entries(isObj(layer.checks) ? layer.checks : {})) {
      if (!(CATEGORIES as readonly string[]).includes(cat)) { errors.push(`${where}.checks.${cat}: unknown category`); continue; }
      for (const [stage, spec] of Object.entries(isObj(stages) ? stages : {})) {
        if (!(QUALITY_STAGES as readonly string[]).includes(stage)) { errors.push(`${where}.checks.${cat}.${stage}: unknown stage`); continue; }
        const s = typeof spec === 'string' ? { level: spec } : (spec as J);
        if (!LEVELS.includes(s?.level as string)) { errors.push(`${where}.checks.${cat}.${stage}.level: must be one of ${JSON.stringify(LEVELS)}`); continue; }
        if (SECURITY.has(cat) && PROMOTION.has(stage) && s.level === 'required' && (s.onUnavailable ?? 'fail-closed') !== 'fail-closed') errors.push(`${where}.checks.${cat}.${stage}.onUnavailable: a required security check must fail closed at a promotion stage`);
      }
    }
  }
  return errors;
}

/** The service does not hold the repository's quality policy, so it applies this conservative cap; the engine enforces the policy's own maximum when it records the waiver. */
export const DEFAULT_MAX_WAIVER_DAYS = 30;

export function maxWaiverDays(doc: J, project: string | null, repoType: string | null): number {
  const w = (effectivePolicy(doc, project, repoType).waivers ?? {}) as J;
  return typeof w.maxDays === 'number' && w.maxDays >= 1 ? Math.min(w.maxDays, 365) : DEFAULT_MAX_WAIVER_DAYS;
}

/** Apply a policy to the last candidate's check matrix at every stage. Nothing is saved or changed. */
export function dryRunPolicy(model: ReleaseCandidatesResponse, req: QualityDryRunRequest): QualityDryRunResponse {
  const doc = req.policy as J;
  const errors = validateQualityPolicy(doc);
  const project = model.projects.find((p) => p.projectId === req.projectId);
  const candidate = project?.active ?? project?.history[0] ?? null;
  const base = { candidateId: candidate?.id ?? null };
  if (errors.length > 0) return { valid: false, errors, ...base, stages: [], estimate: { computeHours: null, basis: 'the policy is not valid' }, warnings: [] };

  const eff = effectivePolicy(doc, req.projectId, req.repoType ?? null);
  const warnings: string[] = [];
  if (!candidate) warnings.push('this project has no candidate yet, so only required checks with no result are shown');
  const results = new Map((candidate?.checkMatrix ?? []).map((r) => [r.category, r.status] as const));
  const stages: QualityDryRunResponse['stages'] = QUALITY_STAGES.map((stage) => {
    const checks = CATEGORIES.flatMap((category) => {
      const spec = specOf(eff, category, stage);
      if (spec.level === 'off') return [];
      const have = results.get(category);
      // A configured check with no result is `unknown`, never a pass.
      const status = have ?? 'unknown';
      return [{
        category, status, level: spec.level, onUnavailable: spec.onUnavailable, blocks: isBlocking(eff, category, stage, status),
        note: have ? `candidate result: ${have}` : 'no result for this check on the last candidate; counted as unknown',
      }];
    });
    return { stage, wouldBlock: checks.some((c) => c.blocks), checks };
  });
  if (candidate?.checkMatrix.some((r) => r.feed === 'stale' || r.feed === 'unavailable')) warnings.push('a scanner feed is stale or unavailable on the last candidate: required security checks fail closed rather than pass');
  const cost = candidate?.cost?.computeSeconds;
  return {
    valid: true, errors: [], ...base, stages, warnings,
    estimate: cost === undefined ? { computeHours: null, basis: 'the last candidate recorded no compute cost' } : { computeHours: Math.round((cost / 3600) * 100) / 100, basis: `recorded compute cost of ${candidate!.id}` },
  };
}

// ---- review-only waiver request --------------------------------------------------------------------------------------------------
export const WAIVERS_FILE = 'waivers.jsonl';
export const waiversPath = (env: NodeJS.ProcessEnv = process.env) => join(cezarHomeDir(env), 'release', WAIVERS_FILE);

export type WaiverDecision = { ok: true; maxDays: number } | { ok: false; status: 400 | 403 | 404 | 409; error: string };

export function evaluateWaiver(model: ReleaseCandidatesResponse, req: WaiverRequest, ctx: { localHandoff: boolean; maxDays: number }): WaiverDecision {
  if (!ctx.localHandoff) return { ok: false, status: 403, error: 'Waivers can only be requested from the local machine, not a remote cockpit.' };
  if (!model.available) return { ok: false, status: 409, error: 'The release engine has not published a candidate snapshot, so the waiver cannot be validated.' };
  const project = model.projects.find((p) => p.projectId === req.projectId);
  if (!project) return { ok: false, status: 404, error: `Project ${req.projectId} has no release candidates.` };
  if (req.expiresInDays > ctx.maxDays) return { ok: false, status: 400, error: `A waiver can last at most ${ctx.maxDays} days under this policy; ${req.expiresInDays} was requested.` };
  if (req.candidateId && ![project.active, ...project.history].some((c) => c?.id === req.candidateId)) return { ok: false, status: 404, error: `Candidate ${req.candidateId} is not known for this project.` };
  return { ok: true, maxDays: ctx.maxDays };
}

/** Appends one audited request. The host engine records the waiver; a failed write means the request was not accepted. */
export function recordWaiver(req: WaiverRequest, decision: Extract<WaiverDecision, { ok: true }>, now: Date, path = waiversPath()): WaiverResponse {
  const expiresAt = new Date(now.getTime() + req.expiresInDays * 86_400_000).toISOString();
  const id = `wvr-${randomUUID().slice(0, 12)}`;
  const entry = {
    id, at: now.toISOString(), actor: 'local-operator', reviewerKind: 'operator', projectId: req.projectId, candidateId: req.candidateId ?? null,
    fingerprint: req.fingerprint ?? null, advisoryId: req.advisoryId ?? null, stages: req.stages, pathGlob: req.pathGlob ?? null,
    reason: redactSecrets(req.reason, collectSecretValues()), expiresAt,
  };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { accepted: true, requestId: id, projectId: req.projectId, expiresAt, maxDays: decision.maxDays, status: 'queued', message: `Waiver requested until ${expiresAt.slice(0, 10)}; the release engine records it.` };
}
