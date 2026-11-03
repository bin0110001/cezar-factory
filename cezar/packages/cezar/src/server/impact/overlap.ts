import { globToRegExp, isManifestStale, opaquePathId, pathKey, type FileImpact, type ImpactManifest } from './manifest.ts';

export type OverlapLevel = 'none' | 'unknown' | 'module' | 'file' | 'contract';

export interface OverlapFinding {
  kind: 'file' | 'contract' | 'module' | 'unknown-coverage';
  /** Redacted for sensitive paths. */
  subject: string;
  confidence: number;
  detail: string;
}

export interface OverlapResult {
  level: OverlapLevel;
  /** Probability-like confidence in `level`; lowered by stale revisions and hypothesis-only evidence. */
  confidence: number;
  findings: OverlapFinding[];
  stale: { a: boolean; b: boolean };
  /** True when the two manifests are for different repositories (never conflict). */
  differentRepository: boolean;
}

export interface OverlapPolicy {
  /** Module-only overlap is a warning unless the project elevates it. */
  elevateModules: boolean;
  /** Confidence multiplier applied per stale manifest. */
  stalePenalty: number;
  currentBaseSha?: { a?: string | null; b?: string | null };
}
export const DEFAULT_OVERLAP_POLICY: OverlapPolicy = { elevateModules: false, stalePenalty: 0.5 };

interface Claim { key: string; path: string; op: FileImpact['op']; glob: boolean; confidence: number; sensitive: boolean }

function claims(m: ImpactManifest): Claim[] {
  const out: Claim[] = [];
  const sensitive = (p: string) => m.sensitiveGlobs.some((g) => globToRegExp(g).test(p)) || /(^|\/)\.env(\.|$)|\.(pem|key|p12|pfx)$|(^|\/)secrets?\//i.test(p);
  for (const f of m.files) {
    out.push({ key: pathKey(f.path), path: f.path, op: f.op, glob: f.glob, confidence: f.confidence, sensitive: sensitive(f.path) });
    if (f.op === 'rename' && f.from) out.push({ key: pathKey(f.from), path: f.from, op: 'delete', glob: false, confidence: f.confidence, sensitive: sensitive(f.from) });
  }
  return out;
}

const staticPrefix = (glob: string) => glob.split(/[*?]/)[0]!.toLowerCase();
const label = (c: Claim) => (c.sensitive ? opaquePathId(c.path) : c.path);

function claimsCollide(a: Claim, b: Claim): { hit: boolean; certain: boolean } {
  if (!a.glob && !b.glob) return { hit: a.key === b.key, certain: true };
  if (a.glob && !b.glob) return { hit: globToRegExp(a.path).test(b.path), certain: false };
  if (!a.glob && b.glob) return { hit: globToRegExp(b.path).test(a.path), certain: false };
  const pa = staticPrefix(a.path), pb = staticPrefix(b.path);
  return { hit: pa.startsWith(pb) || pb.startsWith(pa), certain: false };
}

/**
 * Deterministic overlap of two manifests. Unknown coverage on either side yields `unknown` — it
 * can never be reported as `none`. Module-only overlap is a warning unless policy elevates it,
 * and nothing here ever creates a dependency or blocker.
 */
export function analyzeOverlap(a: ImpactManifest, b: ImpactManifest, policy: OverlapPolicy = DEFAULT_OVERLAP_POLICY): OverlapResult {
  const stale = {
    a: isManifestStale(a, policy.currentBaseSha ? policy.currentBaseSha.a : a.repo.baseSha),
    b: isManifestStale(b, policy.currentBaseSha ? policy.currentBaseSha.b : b.repo.baseSha),
  };
  if (a.repo.repository.toLowerCase() !== b.repo.repository.toLowerCase()) {
    return { level: 'none', confidence: 1, findings: [], stale, differentRepository: true };
  }
  const findings: OverlapFinding[] = [];
  let level = 'none' as OverlapLevel;
  const raise = (to: OverlapLevel) => {
    const order: OverlapLevel[] = ['none', 'unknown', 'module', 'file', 'contract'];
    if (order.indexOf(to) > order.indexOf(level)) level = to;
  };

  for (const ca of claims(a)) for (const cb of claims(b)) {
    const { hit, certain } = claimsCollide(ca, cb);
    if (!hit) continue;
    const confidence = Math.min(ca.confidence, cb.confidence) * (certain ? 1 : 0.5);
    findings.push({ kind: 'file', subject: label(certain ? ca : ca.glob ? cb : ca), confidence, detail: `${a.issue.repository}#${a.issue.number} ${ca.op} vs #${b.issue.number} ${cb.op}${certain ? '' : ' (glob)'}` });
    raise('file');
  }
  const contractsB = new Map(b.contracts.map((c) => [c.id, c]));
  for (const ca of a.contracts) {
    const cb = contractsB.get(ca.id);
    if (!cb) continue;
    findings.push({ kind: 'contract', subject: ca.id, confidence: Math.min(ca.confidence, cb.confidence), detail: `${ca.kind} contract changed by both` });
    raise('contract');
  }
  const modulesB = new Map(b.modules.map((m) => [m.name.toLowerCase(), m]));
  for (const ma of a.modules) {
    const mb = modulesB.get(ma.name.toLowerCase());
    if (!mb) continue;
    findings.push({ kind: 'module', subject: ma.name, confidence: Math.min(ma.confidence, mb.confidence), detail: 'shared module (warning)' });
    if (policy.elevateModules) raise('file'); else raise('module');
  }
  for (const [side, m] of [['a', a], ['b', b]] as const) {
    if (m.coverage !== 'complete') {
      findings.push({ kind: 'unknown-coverage', subject: `#${m.issue.number}`, confidence: 1, detail: `${side === 'a' ? 'first' : 'second'} manifest coverage is ${m.coverage}` });
      raise('unknown');
    }
  }
  // Zones one side could not analyse that the other side's files fall into.
  for (const [x, y] of [[a, b], [b, a]] as const) {
    for (const zone of x.unknownZones) {
      const re = globToRegExp(zone.pattern);
      const hit = y.files.find((f) => (f.glob ? staticPrefix(f.path).startsWith(staticPrefix(zone.pattern)) : re.test(f.path)));
      if (hit) { findings.push({ kind: 'unknown-coverage', subject: zone.pattern, confidence: 0.5, detail: `#${x.issue.number} could not analyse ${zone.pattern}: ${zone.reason}` }); raise('unknown'); }
    }
  }

  let confidence = findings.length === 0 ? 1 : Math.max(...findings.map((f) => f.confidence));
  if (stale.a) confidence *= policy.stalePenalty;
  if (stale.b) confidence *= policy.stalePenalty;
  if (level === 'unknown') confidence = Math.min(confidence, 0.5);
  return { level, confidence: Math.round(confidence * 1000) / 1000, findings, stale, differentRepository: false };
}

export interface BatchCandidate { id: string; manifest: ImpactManifest }
export interface BatchPlan {
  /** Mutually compatible candidates that may start together, in the priority order given. */
  runTogether: string[];
  /** Candidates held back, each with the earlier candidate that blocks it and why. */
  deferred: { id: string; conflictsWith: string; level: OverlapLevel }[];
}

/**
 * Greedy, priority-preserving selection. `candidates` MUST be supplied in dispatch-priority
 * order; an earlier candidate is never displaced by a later one. A later candidate joins only if
 * it is `none`/`module` against everyone already chosen; `unknown` is treated as a conflict so
 * missing knowledge never masquerades as safety. Every candidate is eventually first in its own
 * turn, so deferral cannot starve once earlier ones finish.
 */
export function planBatch(candidates: BatchCandidate[], policy: OverlapPolicy = DEFAULT_OVERLAP_POLICY, maxParallel = Infinity): BatchPlan {
  const chosen: BatchCandidate[] = [];
  const deferred: BatchPlan['deferred'] = [];
  for (const cand of candidates) {
    if (chosen.length >= maxParallel) { deferred.push({ id: cand.id, conflictsWith: chosen[chosen.length - 1]!.id, level: 'none' }); continue; }
    let blocker: { id: string; level: OverlapLevel } | null = null;
    for (const other of chosen) {
      const r = analyzeOverlap(other.manifest, cand.manifest, policy);
      if (r.level === 'file' || r.level === 'contract' || r.level === 'unknown') { blocker = { id: other.id, level: r.level }; break; }
    }
    if (blocker) deferred.push({ id: cand.id, conflictsWith: blocker.id, level: blocker.level });
    else chosen.push(cand);
  }
  return { runTogether: chosen.map((c) => c.id), deferred };
}
