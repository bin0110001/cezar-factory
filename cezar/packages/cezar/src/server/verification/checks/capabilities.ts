import { z } from 'zod';
import { checkCategorySchema, type CheckCategory, type CheckResult } from './check-provider.js';

/**
 * Check capability detection and profiles (#645). What can run is decided from the repository's own contents and the
 * tools a worker reports, never from a hardcoded path or host: a project without the language or tool for a check gets an
 * explicit NOT_APPLICABLE (non-blocking, with a reason), which is distinct from unknown and error.
 */

export type Ecosystem = 'dotnet' | 'typescript' | 'python' | 'godot' | 'container' | 'iac' | 'lockfile';

const RULES: ReadonlyArray<{ ecosystem: Ecosystem; test: (path: string) => boolean }> = [
  { ecosystem: 'dotnet', test: (p) => /\.(csproj|fsproj|vbproj|sln|slnx)$/i.test(p) },
  { ecosystem: 'typescript', test: (p) => /(^|\/)tsconfig(\.[\w-]+)?\.json$/i.test(p) || /\.(ts|tsx)$/i.test(p) && !/\.d\.ts$/i.test(p) },
  { ecosystem: 'python', test: (p) => /(^|\/)(pyproject\.toml|setup\.py|setup\.cfg|requirements[\w.-]*\.txt|Pipfile)$/i.test(p) || /\.py$/i.test(p) },
  { ecosystem: 'godot', test: (p) => /(^|\/)project\.godot$/i.test(p) || /\.gd$/i.test(p) },
  { ecosystem: 'container', test: (p) => /(^|\/)(Dockerfile|Containerfile)(\.[\w-]+)?$/i.test(p) },
  { ecosystem: 'iac', test: (p) => /\.tf$/i.test(p) },
  { ecosystem: 'lockfile', test: (p) => /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|Pipfile\.lock|packages\.lock\.json|go\.sum|Cargo\.lock|requirements[\w.-]*\.txt)$/i.test(p) },
];

/** Ecosystems present among repository-relative paths. Pure: the caller supplies the file list. */
export function detectEcosystems(paths: readonly string[]): Set<Ecosystem> {
  const found = new Set<Ecosystem>();
  for (const raw of paths) {
    const p = raw.replace(/\\/g, '/');
    if (/(^|\/)(node_modules|\.git|bin|obj|\.venv|venv)\//.test(p)) continue;
    for (const rule of RULES) if (rule.test(p)) found.add(rule.ecosystem);
  }
  return found;
}

export const profileCheckSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  category: checkCategorySchema,
  /** Needs this ecosystem in the repository. */
  ecosystem: z.enum(['dotnet', 'typescript', 'python', 'godot', 'container', 'iac', 'lockfile']),
  /** Needs this tool on the worker (looked up by name through the injected detector, never by path). */
  tool: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
}).strict();

export const checkProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  description: z.string().max(300),
  checks: z.array(profileCheckSchema).min(1).max(64),
}).strict().superRefine((p, ctx) => {
  const seen = new Set<string>();
  p.checks.forEach((c, i) => {
    if (seen.has(c.id)) ctx.addIssue({ code: 'custom', path: ['checks', i, 'id'], message: `duplicate check id ${c.id}` });
    seen.add(c.id);
  });
});
export type CheckProfile = z.infer<typeof checkProfileSchema>;
export type ProfileCheck = z.infer<typeof profileCheckSchema>;

/** Built-in profiles. Tool names are generic; where they live is the worker's business. */
export const BUILTIN_PROFILES: readonly CheckProfile[] = [
  {
    id: 'factory-dotnet-ts-python',
    description: '.NET, TypeScript and Python Factory code: native format/lint/type checks plus dependency and secret scanning.',
    checks: [
      { id: 'dotnet-format', category: 'format', ecosystem: 'dotnet', tool: 'dotnet' },
      { id: 'dotnet-build-analyzers', category: 'lint', ecosystem: 'dotnet', tool: 'dotnet' },
      { id: 'ts-lint', category: 'lint', ecosystem: 'typescript', tool: 'eslint' },
      { id: 'ts-typecheck', category: 'type', ecosystem: 'typescript', tool: 'tsc' },
      { id: 'python-lint', category: 'lint', ecosystem: 'python', tool: 'ruff' },
      { id: 'dependency-scan', category: 'sca', ecosystem: 'lockfile', tool: 'dependency-scanner' },
      { id: 'sast-scan', category: 'sast', ecosystem: 'typescript', tool: 'sast-scanner' },
    ],
  },
  {
    id: 'godot-gdscript',
    description: 'Godot/GDScript projects: parser and warning checks.',
    checks: [
      { id: 'gdscript-parse', category: 'lint', ecosystem: 'godot', tool: 'godot' },
      { id: 'dependency-scan', category: 'sca', ecosystem: 'lockfile', tool: 'dependency-scanner' },
    ],
  },
];

export const profileSelectionSchema = z.object({ profile: z.string().min(1).max(64) }).strict();

/** Pick a profile: an explicit id, or `auto` (the built-in whose ecosystems best match; none matching is an error, not a guess). */
export function selectProfile(selection: string, found: ReadonlySet<Ecosystem>, profiles: readonly CheckProfile[] = BUILTIN_PROFILES): CheckProfile {
  if (selection !== 'auto') {
    const hit = profiles.find((p) => p.id === selection);
    if (!hit) throw new Error(`unknown check profile ${selection}; known: ${profiles.map((p) => p.id).join(', ')}`);
    return hit;
  }
  const scored = profiles.map((p) => ({ p, score: new Set(p.checks.filter((c) => found.has(c.ecosystem) && c.ecosystem !== 'lockfile').map((c) => c.id)).size }));
  scored.sort((a, b) => b.score - a.score || a.p.id.localeCompare(b.p.id));
  const best = scored[0];
  if (!best || best.score === 0) throw new Error('no check profile matches the detected ecosystems; select one explicitly');
  return best.p;
}

export type NotApplicableReason = 'ecosystem-absent' | 'tool-missing';

export interface PlannedCheck {
  checkId: string;
  category: CheckCategory;
  action: 'run' | 'not-applicable';
  reason?: NotApplicableReason;
  detail?: string;
}

/** Plan which of a profile's checks run. A missing ecosystem or tool is NOT_APPLICABLE, so no scanner is required for it. */
export function planChecks(profile: CheckProfile, found: ReadonlySet<Ecosystem>, hasTool: (name: string) => boolean): PlannedCheck[] {
  return profile.checks.map((c): PlannedCheck => {
    if (!found.has(c.ecosystem)) return { checkId: c.id, category: c.category, action: 'not-applicable', reason: 'ecosystem-absent', detail: `no ${c.ecosystem} files in the repository` };
    if (!hasTool(c.tool)) return { checkId: c.id, category: c.category, action: 'not-applicable', reason: 'tool-missing', detail: `tool ${c.tool} is not available on this worker` };
    return { checkId: c.id, category: c.category, action: 'run' };
  });
}

/** The contract result for a planned NOT_APPLICABLE check: never run, no findings, a reason, and non-blocking at the gates. */
export function notApplicableResult(planned: PlannedCheck, provider: CheckResult['provider']): CheckResult {
  if (planned.action !== 'not-applicable') throw new Error('only a not-applicable plan produces a not-applicable result');
  return {
    checkId: planned.checkId, provider, status: 'not-applicable', execution: 'not-run', feed: 'not-applicable', findingCount: 0, blockingFindingCount: 0,
    reason: `${planned.reason}: ${planned.detail ?? ''}`.slice(0, 500),
  };
}
