import { createHash } from 'node:crypto';
import { z } from 'zod';
import { collectSecretValues, redactSecrets } from '../../../core/secret-redaction.js';
import { checkCategorySchema, providerIdentitySchema } from './check-provider.js';

/**
 * Normalized findings (#617). Providers (SARIF or generic JSON) map into one
 * shape whose `fingerprint` is independent of the provider, so swapping a
 * provider keeps history. Provider-specific fingerprints are retained in
 * `sourceFingerprints`. Evidence is redacted before it is stored.
 */

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export const severitySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof severitySchema>;

export const normalizedFindingSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  sourceFingerprints: z.array(z.object({ provider: z.string().min(1), value: z.string().min(1).max(512) }).strict()).max(16),
  category: checkCategorySchema,
  /** Security findings (vulnerabilities, secrets, misconfiguration) are separate from quality debt (style, complexity, warnings). */
  class: z.enum(['security', 'quality-debt']).default('security'),
  ruleId: z.string().min(1).max(256),
  commonIds: z.object({
    cve: z.array(z.string()).default([]), ghsa: z.array(z.string()).default([]),
    osv: z.array(z.string()).default([]), cwe: z.array(z.string()).default([]),
  }).strict(),
  severity: severitySchema,
  confidence: z.enum(['high', 'medium', 'low', 'unknown']),
  dependency: z.object({ ecosystem: z.string().optional(), name: z.string().min(1), version: z.string().optional() }).strict().optional(),
  path: z.string().max(1024).optional(),
  line: z.number().int().positive().optional(),
  sourceSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  fix: z.object({ available: z.boolean(), version: z.string().optional() }).strict(),
  references: z.array(z.string().max(2048)).max(20).default([]),
  waiver: z.object({ status: z.enum(['none', 'false-positive', 'waived']), reason: z.string().max(500).optional(), expiresAt: z.string().datetime().optional() }).strict().default({ status: 'none' }),
  provenance: providerIdentitySchema,
  /** Redacted message/evidence; raw secret values never reach here. */
  evidence: z.string().max(4000),
}).strict();
export type NormalizedFinding = z.infer<typeof normalizedFindingSchema>;

const SECURITY_CATEGORIES: ReadonlySet<string> = new Set(['sast', 'sca', 'secrets', 'iac', 'container', 'license', 'sbom']);

/** Security versus quality debt is decided by category, never by the severity a tool reports. */
export function classOfCategory(category: string): 'security' | 'quality-debt' {
  return SECURITY_CATEGORIES.has(category) ? 'security' : 'quality-debt';
}

export interface NormalizeContext {
  provider: z.infer<typeof providerIdentitySchema>;
  category: z.infer<typeof checkCategorySchema>;
  sourceSha: string;
  /** Extra secret values (e.g. planted fixture secrets) to redact in addition to the host env. */
  secrets?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

const idRe = {
  cve: /\bCVE-\d{4}-\d{4,}\b/gi, ghsa: /\bGHSA(?:-[23456789cfghjmpqrvwx]{4}){3}\b/gi,
  osv: /\b(?:OSV|PYSEC|RUSTSEC|GO)-\d{4}-\d+\b/gi, cwe: /\bCWE-\d+\b/gi,
};

function extractIds(...texts: Array<string | undefined>): NormalizedFinding['commonIds'] {
  const all = texts.filter(Boolean).join(' ');
  const pick = (re: RegExp, up = true) => [...new Set((all.match(re) ?? []).map((s) => (up ? s.toUpperCase() : s)))].sort();
  return { cve: pick(idRe.cve), ghsa: pick(idRe.ghsa), osv: pick(idRe.osv), cwe: pick(idRe.cwe) };
}

function mapSeverity(s: string | undefined): Severity {
  const v = (s ?? '').toLowerCase();
  if (v === 'critical') return 'critical';
  if (v === 'high' || v === 'error') return 'high';
  if (v === 'medium' || v === 'moderate' || v === 'warning') return 'medium';
  if (v === 'low') return 'low';
  return 'info';
}

/** Provider-independent identity: the shared advisory id plus the dependency, else category/CWE/rule plus path. */
export function commonFingerprint(f: Pick<NormalizedFinding, 'category' | 'commonIds' | 'dependency' | 'path' | 'ruleId'>): string {
  const advisory = f.commonIds.cve[0] ?? f.commonIds.ghsa[0] ?? f.commonIds.osv[0];
  const parts = advisory && f.dependency
    ? ['advisory', f.category, advisory, f.dependency.ecosystem ?? '', f.dependency.name.toLowerCase()]
    : f.dependency
      // A rule hit on a specific dependency (e.g. a license) is identified per package, not per rule.
      ? ['dependency-rule', f.category, f.ruleId.toLowerCase(), f.dependency.ecosystem ?? '', f.dependency.name.toLowerCase()]
      : ['rule', f.category, f.commonIds.cwe[0] ?? f.ruleId.toLowerCase(), (f.path ?? '').replace(/\\/g, '/')];
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

interface RawFinding {
  providerFingerprint?: string; ruleId: string; severity?: string; confidence?: string; message: string;
  path?: string; line?: number; dependency?: NormalizedFinding['dependency']; fixedVersion?: string;
  references?: string[]; extraIdText?: string[]; falsePositive?: boolean;
}

function build(raw: RawFinding, ctx: NormalizeContext): NormalizedFinding {
  const secrets = [...collectSecretValues(ctx.env ?? process.env), ...(ctx.secrets ?? [])].sort((a, b) => b.length - a.length);
  const redact = (s: string) => redactSecrets(s, secrets);
  const commonIds = extractIds(raw.ruleId, raw.message, ...(raw.extraIdText ?? []));
  const partial = {
    category: ctx.category, commonIds, dependency: raw.dependency, ruleId: raw.ruleId,
    path: raw.path?.replace(/\\/g, '/'),
  };
  return normalizedFindingSchema.parse({
    fingerprint: commonFingerprint(partial),
    sourceFingerprints: raw.providerFingerprint ? [{ provider: ctx.provider.name, value: redact(raw.providerFingerprint) }] : [],
    category: ctx.category, class: classOfCategory(ctx.category), ruleId: redact(raw.ruleId), commonIds,
    severity: mapSeverity(raw.severity),
    confidence: (['high', 'medium', 'low'] as const).find((c) => c === (raw.confidence ?? '').toLowerCase()) ?? 'unknown',
    dependency: raw.dependency, path: partial.path, line: raw.line, sourceSha: ctx.sourceSha,
    fix: { available: Boolean(raw.fixedVersion), version: raw.fixedVersion },
    references: (raw.references ?? []).slice(0, 20).map(redact),
    waiver: raw.falsePositive ? { status: 'false-positive' } : { status: 'none' },
    provenance: ctx.provider, evidence: redact(raw.message).slice(0, 4000),
  });
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? v as Json : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Normalize SARIF 2.1.0 `runs[].results[]`. Invalid structure throws rather than yielding zero findings. */
export function normalizeSarif(sarif: unknown, ctx: NormalizeContext): NormalizedFinding[] {
  const runs = arr(obj(sarif).runs);
  if (!Array.isArray(obj(sarif).runs)) throw new Error('not a SARIF document: missing runs[]');
  const out: NormalizedFinding[] = [];
  for (const run of runs) {
    const rules = new Map(arr(obj(obj(obj(run).tool).driver).rules).map((r) => [str(obj(r).id) ?? '', obj(r)]));
    for (const result of arr(obj(run).results)) {
      const r = obj(result);
      const ruleId = str(r.ruleId) ?? 'unknown-rule';
      const rule = rules.get(ruleId) ?? {};
      const props = { ...obj(rule.properties), ...obj(r.properties) };
      const phys = obj(obj(arr(r.locations)[0]).physicalLocation);
      const pkg = str(props.packageName) ?? str(props.pkgName);
      out.push(build({
        providerFingerprint: str(obj(r.partialFingerprints).primaryLocationLineHash) ?? str(obj(r.fingerprints)['0']),
        ruleId, severity: str(props.severity) ?? str(r.level), confidence: str(props.precision) ?? str(props.confidence),
        message: str(obj(r.message).text) ?? '', path: str(obj(phys.artifactLocation).uri), line: obj(phys.region).startLine as number | undefined,
        dependency: pkg ? { ecosystem: str(props.ecosystem), name: pkg, version: str(props.installedVersion) } : undefined,
        fixedVersion: str(props.fixedVersion), references: [str(rule.helpUri)].filter((x): x is string => Boolean(x)),
        extraIdText: [...arr(props.tags).map(String), ...arr(props.cwe).map(String)],
        falsePositive: arr(r.suppressions).length > 0,
      }, ctx));
    }
  }
  return out;
}

/** Normalize a generic JSON list: `{ findings: [{ id, severity, package, version, fixedVersion, path, line, title, references }] }`. */
export function normalizeGenericJson(doc: unknown, ctx: NormalizeContext): NormalizedFinding[] {
  const list = obj(doc).findings;
  if (!Array.isArray(list)) throw new Error('not a findings document: missing findings[]');
  return list.map((item) => {
    const f = obj(item);
    const pkg = str(f.package);
    return build({
      providerFingerprint: str(f.fingerprint), ruleId: str(f.id) ?? 'unknown-rule', severity: str(f.severity), confidence: str(f.confidence),
      message: str(f.title) ?? str(f.message) ?? '', path: str(f.path), line: typeof f.line === 'number' ? f.line : undefined,
      dependency: pkg ? { ecosystem: str(f.ecosystem), name: pkg, version: str(f.version) } : undefined,
      fixedVersion: str(f.fixedVersion), references: arr(f.references).map(String), extraIdText: arr(f.cwe).map(String),
      falsePositive: f.falsePositive === true,
    }, ctx);
  });
}

export interface FindingQuery { severity?: Severity[]; category?: string; commonId?: string; includeWaived?: boolean }

/** One findings query over normalized output, independent of provider; stable order. */
export function queryFindings(findings: readonly NormalizedFinding[], q: FindingQuery = {}): NormalizedFinding[] {
  const sev = ['critical', 'high', 'medium', 'low', 'info'];
  return findings
    .filter((f) => (!q.severity || q.severity.includes(f.severity)) && (!q.category || f.category === q.category)
      && (!q.commonId || Object.values(f.commonIds).some((ids) => ids.includes(q.commonId!.toUpperCase())))
      && (q.includeWaived || f.waiver.status === 'none'))
    .sort((a, b) => sev.indexOf(a.severity) - sev.indexOf(b.severity) || a.fingerprint.localeCompare(b.fingerprint));
}

/** Merge a swapped provider's findings into history by common fingerprint, keeping every source fingerprint. */
export function mergeByFingerprint(history: readonly NormalizedFinding[], incoming: readonly NormalizedFinding[]): NormalizedFinding[] {
  const map = new Map(history.map((f) => [f.fingerprint, f]));
  for (const f of incoming) {
    const prior = map.get(f.fingerprint);
    if (!prior) { map.set(f.fingerprint, f); continue; }
    const key = (s: { provider: string; value: string }) => `${s.provider}\u0000${s.value}`;
    const seen = new Set(prior.sourceFingerprints.map(key));
    map.set(f.fingerprint, { ...f, sourceFingerprints: [...prior.sourceFingerprints, ...f.sourceFingerprints.filter((s) => !seen.has(key(s)))] });
  }
  return [...map.values()];
}
