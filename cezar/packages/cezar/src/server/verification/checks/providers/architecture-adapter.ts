import { z } from 'zod';
import { notApplicableResult, type PlannedCheck } from '../capabilities.js';
import type { CheckResult } from '../check-provider.js';
import type { CheckProviderPlugin, PluginRunOutput } from '../check-runner.js';

/**
 * Architecture boundary, dependency-cycle and public API/schema compatibility check provider (#670). Opt-in and incremental: it
 * examines only violations that involve changed files. It consumes structure instead of recreating it: import edges come from the code
 * graph (injected `readEdges`), and planned scope and consumer impact come from the Change Impact Manifest (`planned`). Rules are
 * versioned per project; with no rules configured the check is NOT_APPLICABLE through planning.
 *
 * Findings are normalized in the `custom` category (quality debt), so baselined violations stay visible without blocking, and a new one
 * blocks only where policy says so (`blockQualityDebtAt`).
 */

export const architectureRulesSchema = z.object({
  version: z.literal(1),
  /** Named modules by path glob; a file belongs to the first module whose glob matches. */
  modules: z.array(z.object({ name: z.string().min(1).max(64), glob: z.string().min(1).max(256) }).strict()).min(1).max(200),
  /** `from` must not import `to`. */
  boundaries: z.array(z.object({ from: z.string().min(1), to: z.string().min(1), reason: z.string().max(200).default('') }).strict()).max(500).default([]),
  cycles: z.object({ enabled: z.boolean().default(true), level: z.enum(['module', 'file']).default('module') }).strict().default(() => ({ enabled: true, level: 'module' as const })),
  /** Public contracts and the files that define them; compatibility is checked between two surface snapshots. */
  publicApi: z.array(z.object({ id: z.string().min(1).max(256), files: z.array(z.string().min(1)).min(1) }).strict()).max(500).default([]),
}).strict().superRefine((r, ctx) => {
  const names = new Set(r.modules.map((m) => m.name));
  r.boundaries.forEach((b, i) => {
    for (const side of ['from', 'to'] as const) if (!names.has(b[side])) ctx.addIssue({ code: 'custom', path: ['boundaries', i, side], message: `unknown module ${b[side]}` });
  });
});
export type ArchitectureRules = z.infer<typeof architectureRulesSchema>;

export interface Edge { from: string; to: string; line?: number }
/** Hash of a contract's public signature at a point in time. */
export type ApiSurface = Readonly<Record<string, string>>;

export interface PlannedScope {
  files: readonly string[];       // planned file paths or globs
  modules: readonly string[];
  contracts: readonly { id: string; files: readonly string[] }[];
}

const rx = (glob: string) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0001/g, '(?:.*/)?').replace(/\u0000/g, '.*')}$`);
const norm = (p: string) => p.replace(/\\/g, '/');

export function moduleOf(rules: ArchitectureRules, file: string): string | undefined {
  const f = norm(file);
  return rules.modules.find((m) => rx(m.glob).test(f))?.name;
}

/** Tarjan's strongly connected components over a directed graph; returns components with more than one node (or a self-loop). */
export function cycles(nodes: readonly string[], edges: ReadonlyArray<readonly [string, string]>): string[][] {
  const adj = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const [a, b] of edges) { if (!adj.has(a)) adj.set(a, []); if (!adj.has(b)) adj.set(b, []); adj.get(a)!.push(b); }
  const index = new Map<string, number>(); const low = new Map<string, number>(); const onStack = new Set<string>(); const stack: string[] = [];
  const out: string[][] = []; let i = 0;
  const visit = (v: string): void => {
    index.set(v, i); low.set(v, i); i++; stack.push(v); onStack.add(v);
    for (const w of [...(adj.get(v) ?? [])].sort()) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = [];
      for (let w = ''; w !== v;) { w = stack.pop()!; onStack.delete(w); comp.push(w); }
      if (comp.length > 1 || (adj.get(v) ?? []).includes(v)) out.push(comp.sort());
    }
  };
  for (const n of [...adj.keys()].sort()) if (!index.has(n)) visit(n);
  return out.sort((a, b) => a.join().localeCompare(b.join()));
}

export interface ArchitectureInput {
  rules: ArchitectureRules;
  /** Repo-relative paths changed by this change. Only violations involving them are reported (incremental). */
  changedFiles: readonly string[];
  /** All import edges known to the code graph. */
  edges: readonly Edge[];
  apiBefore?: ApiSurface;
  apiAfter?: ApiSurface;
  planned?: PlannedScope;
}

export interface ArchFinding { id: string; severity: 'high' | 'medium' | 'low'; title: string; path?: string; line?: number }

export function analyzeArchitecture(input: ArchitectureInput): ArchFinding[] {
  const { rules } = input;
  const changed = new Set(input.changedFiles.map(norm));
  const out: ArchFinding[] = [];

  // Boundaries: an import from a forbidden module, in a changed file.
  for (const e of input.edges) {
    const from = norm(e.from); const to = norm(e.to);
    if (!changed.has(from)) continue;
    const a = moduleOf(rules, from); const b = moduleOf(rules, to);
    if (!a || !b || a === b) continue;
    const hit = rules.boundaries.find((x) => x.from === a && x.to === b);
    if (hit) out.push({ id: `arch.boundary:${a}->${b}`, severity: 'high', title: `${from} (${a}) imports ${to} (${b}), which the boundary rules forbid${hit.reason ? `: ${hit.reason}` : ''}`, path: from, ...(e.line ? { line: e.line } : {}) });
  }

  // Cycles: only components that include something changed, at module or file level.
  if (rules.cycles.enabled) {
    const level = rules.cycles.level;
    const key = (f: string) => (level === 'file' ? norm(f) : moduleOf(rules, f));
    const nodes = new Set<string>(); const pairs: Array<[string, string]> = [];
    for (const e of input.edges) {
      const a = key(e.from); const b = key(e.to);
      if (!a || !b) continue;
      nodes.add(a); nodes.add(b);
      if (a !== b || level === 'file') pairs.push([a, b]);
    }
    const touched = new Set([...changed].map(key).filter((x): x is string => Boolean(x)));
    for (const comp of cycles([...nodes], pairs)) {
      if (!comp.some((n) => touched.has(n))) continue;
      out.push({ id: `arch.cycle:${comp.join('|')}`, severity: 'medium', title: `dependency cycle among ${comp.join(', ')}`, path: comp.find((n) => touched.has(n)) });
    }
  }

  // Public API compatibility between two surface snapshots: removed or changed signatures are breaking, additions are fine.
  if (input.apiBefore && input.apiAfter) {
    for (const [id, sig] of Object.entries(input.apiBefore).sort(([a], [b]) => a.localeCompare(b))) {
      const after = input.apiAfter[id];
      const def = rules.publicApi.find((c) => c.id === id);
      if (after === undefined) out.push({ id: `arch.api-removed:${id}`, severity: 'high', title: `public contract ${id} was removed`, ...(def ? { path: def.files[0] } : {}) });
      else if (after !== sig) out.push({ id: `arch.api-changed:${id}`, severity: 'high', title: `public contract ${id} changed its signature`, ...(def ? { path: def.files[0] } : {}) });
    }
  }

  // Planned versus actual scope and consumer impact, from the impact manifest.
  if (input.planned) {
    const plannedFiles = input.planned.files.map((f) => rx(norm(f)));
    const plannedModules = new Set(input.planned.modules);
    for (const f of [...changed].sort()) {
      const inPlan = plannedFiles.some((r) => r.test(f)) || (moduleOf(rules, f) !== undefined && plannedModules.has(moduleOf(rules, f) as string));
      if (!inPlan) out.push({ id: 'arch.unplanned-change', severity: 'low', title: `${f} changed but is outside the planned scope`, path: f });
    }
    const plannedContracts = new Set(input.planned.contracts.map((c) => c.id));
    for (const c of rules.publicApi) {
      if (c.files.some((f) => changed.has(norm(f))) && !plannedContracts.has(c.id)) out.push({ id: `arch.unplanned-contract:${c.id}`, severity: 'medium', title: `contract ${c.id} changed but the plan did not declare its consumers`, path: c.files[0] });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id) || (a.path ?? '').localeCompare(b.path ?? ''));
}

export interface ArchitecturePluginOptions {
  rules: ArchitectureRules | undefined;
  changedFiles: () => Promise<readonly string[]>;
  readEdges: () => Promise<readonly Edge[]>;
  readApi?: () => Promise<{ before: ApiSurface; after: ApiSurface } | undefined>;
  readPlanned?: () => Promise<PlannedScope | undefined>;
}

export function architecturePlugin(opts: ArchitecturePluginOptions): CheckProviderPlugin {
  return {
    async run(): Promise<PluginRunOutput> {
      if (!opts.rules) return { format: 'json', document: { findings: [] }, notApplicable: 'no architecture rules are configured', noFeed: true };
      const [changedFiles, edges, api, planned] = await Promise.all([opts.changedFiles(), opts.readEdges(), opts.readApi?.(), opts.readPlanned?.()]);
      const findings = analyzeArchitecture({ rules: opts.rules, changedFiles, edges, ...(api ? { apiBefore: api.before, apiAfter: api.after } : {}), ...(planned ? { planned } : {}) });
      return { format: 'json', document: { findings: findings.map((f) => ({ id: f.id, severity: f.severity, title: f.title, path: f.path, line: f.line })) }, noFeed: true };
    },
  };
}

/** Planning-time answer: no rules means NOT_APPLICABLE (non-blocking, with a reason), never a silent pass. */
export function planArchitectureCheck(rules: ArchitectureRules | undefined): PlannedCheck {
  return rules
    ? { checkId: 'architecture', category: 'custom', action: 'run' }
    : { checkId: 'architecture', category: 'custom', action: 'not-applicable', reason: 'ecosystem-absent', detail: 'no architecture rules are configured for this project' };
}

export function architectureNotApplicable(provider: CheckResult['provider']): CheckResult {
  return notApplicableResult(planArchitectureCheck(undefined), provider);
}
