import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Change Impact Manifest v1 — the structured, revision-pinned output of #178 planning that the
 * conflict analyzer (overlap.ts) and scheduler consume. It is a *prediction*: every item carries a
 * source and confidence, and absent knowledge is declared (`unknownZones`, `coverage`), never
 * implied to be conflict-free.
 */
export const MANIFEST_SCHEMA_VERSION = 1;

export const IMPACT_SOURCES = ['code-graph', 'agent-hypothesis', 'human'] as const;
const confidence = z.number().min(0).max(1);
const source = z.enum(IMPACT_SOURCES);

export const fileImpactSchema = z.object({
  /** Repo-relative path or (when `glob`) a glob. Stored normalised; see normalizeRepoPath. */
  path: z.string().min(1),
  op: z.enum(['modify', 'add', 'delete', 'rename']),
  /** Previous path for `rename` (the new path is `path`). */
  from: z.string().min(1).optional(),
  glob: z.boolean().default(false),
  confidence,
  source,
  evidence: z.string().optional(),
}).refine((f) => f.op !== 'rename' || f.from !== undefined, { message: 'rename requires "from"' });

export const moduleImpactSchema = z.object({ name: z.string().min(1), confidence, source });

export const CONTRACT_KINDS = ['interface', 'serialization', 'network', 'build', 'migration', 'godot-resource'] as const;
export const contractImpactSchema = z.object({
  /** Stable identity, e.g. `IInventory`, `uid://c4x1`, `POST /api/runs`, `migration:0042`. */
  id: z.string().min(1),
  kind: z.enum(CONTRACT_KINDS),
  /** Files that define the contract (C# partial classes list every part). */
  files: z.array(z.string().min(1)).default([]),
  confidence,
  source,
});

export const impactManifestSchema = z.object({
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  issue: z.object({ repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/), number: z.number().int().positive() }),
  runId: z.string().optional(),
  repo: z.object({ repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/), branch: z.string().min(1), baseSha: z.string().regex(/^[0-9a-f]{7,64}$/) }),
  /** Increments each time the planner regenerates the manifest for the same issue. */
  manifestRevision: z.number().int().min(1),
  generatedAt: z.string().min(1),
  mode: z.enum(['code-first', 'spec-first']),
  planRef: z.string().optional(),
  specRef: z.string().optional(),
  files: z.array(fileImpactSchema).default([]),
  modules: z.array(moduleImpactSchema).default([]),
  contracts: z.array(contractImpactSchema).default([]),
  tests: z.array(z.string()).default([]),
  ownership: z.array(z.string()).default([]),
  /** Areas the planner could not analyse. Any entry makes coverage "partial" at best. */
  unknownZones: z.array(z.object({ pattern: z.string().min(1), reason: z.string() })).default([]),
  /** Globs whose paths must never be shown to the scheduler/UI (licensed or secret content). */
  sensitiveGlobs: z.array(z.string()).default([]),
  coverage: z.enum(['complete', 'partial', 'unknown']),
});
export type ImpactManifest = z.infer<typeof impactManifestSchema>;
export type FileImpact = z.infer<typeof fileImpactSchema>;

export type ManifestParse = { ok: true; manifest: ImpactManifest } | { ok: false; errors: string[] };

/** Validate and canonicalise. Unknown schema versions are rejected, never guessed at. */
export function parseManifest(input: unknown): ManifestParse {
  const result = impactManifestSchema.safeParse(input);
  if (!result.success) return { ok: false, errors: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  const m = result.data;
  const errors: string[] = [];
  const canon = (p: string, glob: boolean): string | null => {
    const n = normalizeRepoPath(p, glob);
    if (n === null) errors.push(`unsafe path "${p}"`);
    return n;
  };
  const files = m.files.flatMap((f) => {
    const path = canon(f.path, f.glob);
    const from = f.from === undefined ? undefined : canon(f.from, false);
    return path === null || from === null ? [] : [{ ...f, path, ...(from === undefined ? {} : { from }) }];
  });
  const contracts = m.contracts.map((c) => ({ ...c, files: c.files.flatMap((p) => { const n = canon(p, false); return n === null ? [] : [n]; }) }));
  if (errors.length > 0) return { ok: false, errors };
  // Declared gaps must not be contradicted by a "complete" claim.
  const coverage = m.unknownZones.length > 0 && m.coverage === 'complete' ? 'partial' : m.coverage;
  return { ok: true, manifest: { ...m, files, contracts, coverage } };
}

/** An empty manifest is "we know nothing", not "touches nothing". */
export function emptyManifest(issue: ImpactManifest['issue'], repo: ImpactManifest['repo'], now: string): ImpactManifest {
  return { schemaVersion: 1, issue, repo, manifestRevision: 1, generatedAt: now, mode: 'code-first', files: [], modules: [], contracts: [], tests: [], ownership: [], unknownZones: [], sensitiveGlobs: [], coverage: 'unknown' };
}

/**
 * Normalise a repo-relative path: forward slashes, no `./`, no duplicate separators. Returns
 * null for absolute paths or `..` traversal (never invent or follow a path outside the repo).
 */
export function normalizeRepoPath(path: string, glob = false): string | null {
  const unified = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (/^([a-zA-Z]:)?\//.test(unified)) return null;
  const parts: string[] = [];
  for (const part of unified.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  if (parts.length === 0) return null;
  const out = parts.join('/');
  return glob || !/[*?]/.test(out) ? out : null;
}

/** Case-insensitive comparison key: Windows/macOS checkouts must not disagree about identity. */
export function pathKey(path: string): string { return path.toLowerCase(); }

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/** A manifest is stale once the branch it was planned against has advanced. */
export function isManifestStale(manifest: ImpactManifest, currentBaseSha: string | null | undefined): boolean {
  if (!currentBaseSha) return true; // unknown freshness is treated as stale
  const a = manifest.repo.baseSha.toLowerCase(), b = currentBaseSha.toLowerCase();
  return !(a.startsWith(b) || b.startsWith(a));
}

const DEFAULT_SENSITIVE = [/(^|\/)\.env(\.|$)/i, /\.(pem|key|p12|pfx)$/i, /(^|\/)secrets?\//i];

function isSensitive(path: string, globs: string[]): boolean {
  return DEFAULT_SENSITIVE.some((r) => r.test(path)) || globs.some((g) => globToRegExp(g).test(path));
}

export interface SchedulerFileImpact { key: string; path: string | null; op: FileImpact['op']; glob: boolean; confidence: number; source: FileImpact['source'] }

/** Opaque identity for paths that must not leak; equal paths hash equally so overlap still works. */
export function opaquePathId(path: string): string {
  return `redacted:${createHash('sha256').update(pathKey(path)).digest('hex').slice(0, 16)}`;
}

/** Scheduler-facing view: sensitive paths are replaced by opaque ids that still match each other. */
export function redactForScheduler(manifest: ImpactManifest): SchedulerFileImpact[] {
  return manifest.files.map((f) => {
    const sensitive = isSensitive(f.path, manifest.sensitiveGlobs) || (f.from !== undefined && isSensitive(f.from, manifest.sensitiveGlobs));
    return { key: sensitive ? opaquePathId(f.path) : pathKey(f.path), path: sensitive ? null : f.path, op: f.op, glob: f.glob, confidence: f.confidence, source: f.source };
  });
}
