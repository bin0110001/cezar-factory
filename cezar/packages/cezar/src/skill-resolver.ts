import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Deterministic skill resolution (#169). Extends the existing discovery
 * (`skills.ts`, local-first) and directory materialization (`skills-remote.ts`)
 * with: project-type policies, an explicit precedence order, a per-task
 * lockfile pinning exact skill bytes, and a content-addressed bundle cache.
 *
 * Everything here is pure data in / data out except the cache and lockfile
 * helpers, which only touch the directories they are handed. No network: a
 * bundle is either in the cache (integrity-checked) or resolution fails
 * before the agent starts.
 */

/** Highest precedence first. A lower layer never replaces a higher one. */
export const SKILL_PRECEDENCE = ['protected', 'project', 'task', 'catalog'] as const;
export type SkillLayer = (typeof SKILL_PRECEDENCE)[number];

/** Names owned by Factory; no registry/catalog entry may shadow them. */
export const PROTECTED_SKILL_PREFIX = 'factory-';

/** A skill bundle: relative path -> bytes. Content-addressed by `bundleHash`. */
export type SkillBundle = Record<string, string>;

export interface SkillCandidate {
  name: string;
  layer: SkillLayer;
  /** Where it came from (repo@commit, path…), for provenance only. */
  origin: string;
  tags?: string[];
  /** Capabilities this skill needs (e.g. `godot`); all must be provided. */
  requires?: string[];
  /** Pre-resolved bundle (local / protected skills). Catalog skills use the cache. */
  bundle?: SkillBundle;
  /** Catalog skills: the pinned content hash to fetch from the cache. */
  hash?: string;
  /** Catalog skills: commit the catalog entry was read at. */
  commit?: string;
  /** Required skills fail resolution when unavailable; optional ones are denied. */
  required?: boolean;
}

export interface ProjectTypePolicy {
  type: string;
  /** Files (relative to project root) whose presence marks the project type. */
  detect: string[];
  /** Catalog skill names always selected for this type. */
  required?: string[];
  /** Catalog skills selected when the task tags/capabilities match. */
  optional?: Array<{ name: string; tags?: string[] }>;
}

export interface SelectionInput {
  projectType: string | null;
  policies: ProjectTypePolicy[];
  candidates: SkillCandidate[];
  /** Skills the task itself asks for (layer `task`). */
  taskAdditions?: string[];
  taskTags?: string[];
  /** Capabilities the environment provides, for `requires` checks. */
  capabilities?: string[];
}

export interface SkillDecision {
  name: string;
  outcome: 'selected' | 'denied';
  layer: SkillLayer;
  origin: string;
  reason: string;
}

export interface ResolvedSkill {
  name: string;
  layer: SkillLayer;
  origin: string;
  commit?: string;
  hash: string;
  files: string[];
}

export interface SkillManifest {
  version: 1;
  projectType: string | null;
  skills: ResolvedSkill[];
  decisions: SkillDecision[];
}

export class SkillResolutionError extends Error {
  readonly code: 'required-unavailable' | 'integrity' | 'unsafe-path' | 'lock-mismatch';
  constructor(message: string, code: 'required-unavailable' | 'integrity' | 'unsafe-path' | 'lock-mismatch') {
    super(message);
    this.name = 'SkillResolutionError';
    this.code = code;
  }
}

/** The project type whose `detect` files exist, first policy in list order wins. */
export function detectProjectType(
  policies: ProjectTypePolicy[],
  hasFile: (rel: string) => boolean,
): string | null {
  for (const p of policies) {
    if (p.detect.some((f) => hasFile(f))) return p.type;
  }
  return null;
}

const layerRank = (l: SkillLayer): number => SKILL_PRECEDENCE.indexOf(l);

/**
 * Pure, deterministic selection. Order of the input never changes the result:
 * candidates are ranked by (layer, name, origin). Catalog candidates are only
 * considered when the project-type policy (or task additions) names them, and
 * are denied — with a recorded reason — when they would shadow a protected
 * `factory-*` name or any higher-layer skill, or when `requires` is unmet.
 */
export function selectSkills(input: SelectionInput): {
  chosen: SkillCandidate[];
  decisions: SkillDecision[];
} {
  const caps = new Set(input.capabilities ?? []);
  const tags = new Set(input.taskTags ?? []);
  const policy = input.policies.find((p) => p.type === input.projectType);
  const wanted = new Set<string>(input.taskAdditions ?? []);
  for (const n of policy?.required ?? []) wanted.add(n);
  for (const o of policy?.optional ?? []) {
    if (!o.tags || o.tags.length === 0 || o.tags.some((t) => tags.has(t))) wanted.add(o.name);
  }

  const sorted = [...input.candidates].sort(
    (a, b) =>
      layerRank(a.layer) - layerRank(b.layer) ||
      a.name.localeCompare(b.name) ||
      a.origin.localeCompare(b.origin),
  );

  const chosen = new Map<string, SkillCandidate>();
  const decisions: SkillDecision[] = [];
  const deny = (c: SkillCandidate, reason: string): void => {
    decisions.push({ name: c.name, outcome: 'denied', layer: c.layer, origin: c.origin, reason });
  };

  for (const c of sorted) {
    const protectedName = c.name.startsWith(PROTECTED_SKILL_PREFIX);
    if (c.layer === 'catalog' || c.layer === 'task') {
      if (protectedName && c.layer === 'catalog') {
        deny(c, `catalog entry may not shadow protected Factory skill "${c.name}"`);
        continue;
      }
    }
    if (c.layer === 'catalog' && !wanted.has(c.name)) continue; // not selected: not a decision
    const prior = chosen.get(c.name);
    if (prior) {
      deny(c, `shadowed by ${prior.layer} skill from ${prior.origin}`);
      continue;
    }
    const missing = (c.requires ?? []).filter((r) => !caps.has(r));
    if (missing.length > 0) {
      deny(c, `unmet requirements: ${missing.join(', ')}`);
      continue;
    }
    chosen.set(c.name, c);
    decisions.push({
      name: c.name,
      outcome: 'selected',
      layer: c.layer,
      origin: c.origin,
      reason: c.layer === 'catalog' ? `project type "${input.projectType ?? 'none'}" policy` : `${c.layer} skill`,
    });
  }
  return { chosen: [...chosen.values()].sort((a, b) => a.name.localeCompare(b.name)), decisions };
}

// ---- content addressing ---------------------------------------------------------

/** Reject absolute paths, `..` segments, backslashes and empty names. */
export function assertSafeRelPath(rel: string): void {
  if (
    !rel ||
    rel.startsWith('/') ||
    rel.includes('\\') ||
    rel.includes('\0') ||
    rel.split('/').some((s) => s === '..' || s === '' || s === '.')
  ) {
    throw new SkillResolutionError(`unsafe skill file path: ${JSON.stringify(rel)}`, 'unsafe-path');
  }
}

/** sha256 over the sorted (path, content) pairs — stable regardless of insertion order. */
export function bundleHash(bundle: SkillBundle): string {
  const h = createHash('sha256');
  for (const rel of Object.keys(bundle).sort()) {
    assertSafeRelPath(rel);
    const content = bundle[rel] as string;
    h.update(`${rel}\0${Buffer.byteLength(content)}\0`);
    h.update(content);
  }
  return h.digest('hex');
}

const HASH_RE = /^[0-9a-f]{64}$/;

function cacheDirFor(cacheRoot: string, hash: string): string {
  if (!HASH_RE.test(hash)) throw new SkillResolutionError(`invalid bundle hash: ${hash}`, 'integrity');
  return join(cacheRoot, hash);
}

/** Store a bundle under its content hash. Idempotent; atomic via rename. */
export async function cacheBundle(cacheRoot: string, bundle: SkillBundle): Promise<string> {
  const hash = bundleHash(bundle);
  const dest = cacheDirFor(cacheRoot, hash);
  if (existsSync(dest)) return hash;
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  for (const [rel, content] of Object.entries(bundle)) {
    const target = join(tmp, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  await mkdir(cacheRoot, { recursive: true });
  try {
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    if (!existsSync(dest)) throw err;
  }
  return hash;
}

async function walk(dir: string, base = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(dir, rel)));
    else if (e.isFile()) out.push(rel);
    // symlinks and specials are never part of a bundle
  }
  return out;
}

/** Read a cached bundle and verify its bytes still hash to `hash`. */
export async function readCachedBundle(cacheRoot: string, hash: string): Promise<SkillBundle | null> {
  const dir = cacheDirFor(cacheRoot, hash);
  if (!existsSync(dir)) return null;
  const bundle: SkillBundle = {};
  for (const rel of await walk(dir)) bundle[rel] = await readFile(join(dir, rel), 'utf8');
  if (bundleHash(bundle) !== hash) {
    throw new SkillResolutionError(`cached skill bundle ${hash} failed its integrity check`, 'integrity');
  }
  return bundle;
}

// ---- lockfile / pinning ---------------------------------------------------------

export const SKILL_LOCK_FILE = 'skills.lock.json';

export function lockPath(taskDir: string): string {
  return join(taskDir, SKILL_LOCK_FILE);
}

export async function readLock(taskDir: string): Promise<SkillManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath(taskDir), 'utf8')) as SkillManifest;
    return parsed.version === 1 && Array.isArray(parsed.skills) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeLock(taskDir: string, manifest: SkillManifest): Promise<void> {
  await mkdir(taskDir, { recursive: true });
  await writeFile(lockPath(taskDir), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

export interface ResolveOptions extends SelectionInput {
  cacheRoot: string;
  /** Task-scoped directory holding the lockfile; its presence pins the task. */
  taskDir: string;
  /**
   * Catalog bundle fetcher for skills not yet cached. Omitted when offline;
   * a required skill then fails if its hash is not already in the cache.
   */
  fetchBundle?: (c: SkillCandidate) => Promise<SkillBundle | null>;
}

export interface Resolution {
  manifest: SkillManifest;
  bundles: Map<string, SkillBundle>;
  /** True when the existing lockfile was reused and the catalog was not consulted. */
  pinned: boolean;
}

/**
 * Resolve the effective skill set for a task. If the task already has a
 * lockfile (retry / resume) the manifest is replayed from the cache and the
 * live catalog is ignored, so identical bytes are served for the task's
 * lifetime. Otherwise: select, fetch/cache, verify, and write the lock.
 */
export async function resolveSkills(opts: ResolveOptions): Promise<Resolution> {
  const lock = await readLock(opts.taskDir);
  if (lock) {
    const bundles = new Map<string, SkillBundle>();
    for (const s of lock.skills) {
      const b = await readCachedBundle(opts.cacheRoot, s.hash);
      if (!b) {
        throw new SkillResolutionError(
          `pinned skill "${s.name}" (${s.hash}) is missing from the bundle cache`,
          'lock-mismatch',
        );
      }
      bundles.set(s.name, b);
    }
    return { manifest: lock, bundles, pinned: true };
  }

  const { chosen, decisions } = selectSkills(opts);
  const skills: ResolvedSkill[] = [];
  const bundles = new Map<string, SkillBundle>();
  for (const c of chosen) {
    let bundle: SkillBundle | null = null;
    let hash: string;
    if (c.bundle) {
      bundle = c.bundle;
      hash = await cacheBundle(opts.cacheRoot, bundle);
    } else if (c.hash) {
      hash = c.hash;
      bundle = await readCachedBundle(opts.cacheRoot, hash); // throws on tamper
      if (!bundle && opts.fetchBundle) {
        const fetched = await opts.fetchBundle(c);
        if (fetched) {
          const got = await cacheBundle(opts.cacheRoot, fetched);
          if (got !== hash) {
            throw new SkillResolutionError(
              `skill "${c.name}" content hash ${got} does not match pinned ${hash}`,
              'integrity',
            );
          }
          bundle = fetched;
        }
      }
    } else {
      hash = '';
    }
    if (!bundle) {
      const reason = `skill "${c.name}" is unavailable: no cached bundle${c.hash ? ` for ${c.hash}` : ''} and no network source`;
      if (c.required || c.layer !== 'catalog') {
        throw new SkillResolutionError(reason, 'required-unavailable');
      }
      decisions.push({ name: c.name, outcome: 'denied', layer: c.layer, origin: c.origin, reason });
      continue;
    }
    bundles.set(c.name, bundle);
    skills.push({
      name: c.name,
      layer: c.layer,
      origin: c.origin,
      ...(c.commit ? { commit: c.commit } : {}),
      hash,
      files: Object.keys(bundle).sort(),
    });
  }
  const manifest: SkillManifest = {
    version: 1,
    projectType: opts.projectType,
    skills,
    // A skill that was selected then denied for availability is not "selected".
    decisions: decisions.filter((d) => d.outcome === 'denied' || bundles.has(d.name)),
  };
  await writeLock(opts.taskDir, manifest);
  return { manifest, bundles, pinned: false };
}

/**
 * Write resolved bundles into the worktree under `.claude/skills/<name>/`.
 * Paths are re-validated and confined to the destination; files are written
 * verbatim so scripts execute from the worktree, never from the cache.
 */
export async function materializeBundles(
  worktree: string,
  bundles: Map<string, SkillBundle>,
): Promise<string[]> {
  const written: string[] = [];
  const root = resolve(worktree, '.claude', 'skills');
  for (const [name, bundle] of [...bundles].sort(([a], [b]) => a.localeCompare(b))) {
    assertSafeRelPath(name);
    const destDir = resolve(root, name);
    for (const [rel, content] of Object.entries(bundle)) {
      assertSafeRelPath(rel);
      const target = resolve(destDir, rel);
      if (!target.startsWith(destDir + sep)) {
        throw new SkillResolutionError(`skill file escapes its directory: ${rel}`, 'unsafe-path');
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
      written.push(target);
    }
  }
  return written;
}
