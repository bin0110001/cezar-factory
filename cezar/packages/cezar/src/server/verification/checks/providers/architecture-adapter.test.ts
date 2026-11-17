import { describe, expect, it } from 'vitest';
import { checkProviderConfigSchema } from '../check-provider.js';
import { runCheck } from '../check-runner.js';
import { baselineFrom, evaluateFindingGate } from '../finding-policy.js';
import {
  analyzeArchitecture, architectureNotApplicable, architecturePlugin, architectureRulesSchema, cycles, planArchitectureCheck, type ArchitectureRules, type Edge,
} from './architecture-adapter.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const NOW = new Date('2026-11-16T12:00:00Z');
const rules: ArchitectureRules = architectureRulesSchema.parse({
  version: 1,
  modules: [{ name: 'ui', glob: 'src/ui/**' }, { name: 'domain', glob: 'src/domain/**' }, { name: 'infra', glob: 'src/infra/**' }, { name: 'shared', glob: 'src/shared/**' }],
  boundaries: [{ from: 'domain', to: 'ui', reason: 'domain must not know the UI' }, { from: 'domain', to: 'infra' }],
  publicApi: [{ id: 'POST /api/runs', files: ['src/domain/runs-api.ts'] }],
});
const e = (from: string, to: string, line = 1): Edge => ({ from, to, line });

describe('rules', () => {
  it('validate: boundaries must name known modules and unknown fields are rejected', () => {
    expect(architectureRulesSchema.safeParse({ version: 1, modules: [{ name: 'a', glob: 'a/**' }], boundaries: [{ from: 'a', to: 'ghost' }] }).success).toBe(false);
    expect(architectureRulesSchema.safeParse({ ...rules, extra: 1 }).success).toBe(false);
    expect(architectureRulesSchema.safeParse({ version: 2, modules: [{ name: 'a', glob: 'a' }] }).success).toBe(false);
    expect(rules.cycles).toEqual({ enabled: true, level: 'module' });
  });
});

describe('boundaries', () => {
  it('a new forbidden import in a changed file is a finding with its location and reason', () => {
    const f = analyzeArchitecture({ rules, changedFiles: ['src/domain/run.ts'], edges: [e('src/domain/run.ts', 'src/ui/view.ts', 7), e('src/domain/run.ts', 'src/shared/util.ts')] });
    expect(f).toEqual([expect.objectContaining({ id: 'arch.boundary:domain->ui', severity: 'high', path: 'src/domain/run.ts', line: 7 })]);
    expect(f[0]!.title).toContain('domain must not know the UI');
  });

  it('is incremental: a violation in an unchanged file is not reported', () => {
    const edges = [e('src/domain/old.ts', 'src/infra/db.ts')];
    expect(analyzeArchitecture({ rules, changedFiles: ['src/ui/other.ts'], edges })).toEqual([]);
    expect(analyzeArchitecture({ rules, changedFiles: ['src/domain/old.ts'], edges }).map((x) => x.id)).toEqual(['arch.boundary:domain->infra']);
  });

  it('allows imports in the same module and in permitted directions', () => {
    expect(analyzeArchitecture({ rules, changedFiles: ['src/ui/a.ts', 'src/domain/b.ts'], edges: [e('src/ui/a.ts', 'src/domain/b.ts'), e('src/domain/b.ts', 'src/domain/c.ts'), e('src/ui/a.ts', 'src/ui/z.ts')] })).toEqual([]);
  });
});

describe('cycles', () => {
  it('finds strongly connected components, including self-loops, deterministically', () => {
    expect(cycles(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['c', 'a'], ['c', 'd']])).toEqual([['a', 'b', 'c']]);
    expect(cycles(['x'], [['x', 'x']])).toEqual([['x']]);
    expect(cycles(['a', 'b'], [['a', 'b']])).toEqual([]);
  });

  it('reports a new module cycle only when it involves a changed file', () => {
    const edges = [e('src/ui/a.ts', 'src/infra/b.ts'), e('src/infra/b.ts', 'src/shared/c.ts'), e('src/shared/c.ts', 'src/ui/a.ts')];
    const hit = analyzeArchitecture({ rules, changedFiles: ['src/shared/c.ts'], edges });
    expect(hit).toEqual([expect.objectContaining({ id: 'arch.cycle:infra|shared|ui', severity: 'medium' })]);
    expect(analyzeArchitecture({ rules, changedFiles: ['src/domain/unrelated.ts'], edges })).toEqual([]);
    expect(analyzeArchitecture({ rules: { ...rules, cycles: { enabled: false, level: 'module' } }, changedFiles: ['src/shared/c.ts'], edges })).toEqual([]);
  });

  it('supports file-level cycles', () => {
    const edges = [e('src/ui/a.ts', 'src/ui/b.ts'), e('src/ui/b.ts', 'src/ui/a.ts')];
    expect(analyzeArchitecture({ rules: { ...rules, cycles: { enabled: true, level: 'file' } }, changedFiles: ['src/ui/a.ts'], edges }).map((x) => x.id)).toEqual(['arch.cycle:src/ui/a.ts|src/ui/b.ts']);
    expect(analyzeArchitecture({ rules, changedFiles: ['src/ui/a.ts'], edges })).toEqual([]); // same module: not a module cycle
  });
});

describe('public API compatibility', () => {
  it('removed and changed signatures are breaking; additions are not', () => {
    const f = analyzeArchitecture({ rules, changedFiles: [], edges: [], apiBefore: { 'POST /api/runs': 'h1', 'GET /api/x': 'h2' }, apiAfter: { 'POST /api/runs': 'h9', 'GET /api/new': 'h3' } });
    expect(f.map((x) => x.id)).toEqual(['arch.api-changed:POST /api/runs', 'arch.api-removed:GET /api/x']);
    expect(f[0]).toMatchObject({ severity: 'high', path: 'src/domain/runs-api.ts' });
    expect(analyzeArchitecture({ rules, changedFiles: [], edges: [], apiBefore: { a: '1' }, apiAfter: { a: '1', b: '2' } })).toEqual([]);
  });
});

describe('planned versus actual scope and consumer impact', () => {
  const planned = { files: ['src/domain/**'], modules: ['shared'], contracts: [] as Array<{ id: string; files: string[] }> };
  it('flags changes outside the plan and a changed contract the plan did not declare', () => {
    const f = analyzeArchitecture({ rules, changedFiles: ['src/domain/runs-api.ts', 'src/shared/u.ts', 'src/infra/db.ts'], edges: [], planned });
    expect(f.map((x) => x.id)).toEqual(['arch.unplanned-change', 'arch.unplanned-contract:POST /api/runs']);
    expect(f[0]!.path).toBe('src/infra/db.ts');
    const declared = analyzeArchitecture({ rules, changedFiles: ['src/domain/runs-api.ts'], edges: [], planned: { ...planned, contracts: [{ id: 'POST /api/runs', files: ['src/domain/runs-api.ts'] }] } });
    expect(declared).toEqual([]);
  });
});

describe('through the check pipeline', () => {
  const def = checkProviderConfigSchema.parse({ version: 1, checks: [{ id: 'architecture', category: 'custom', provider: { name: 'architecture', version: '1', digest: DIGEST }, scopes: ['changed-files'], triggers: ['pr-dev'], policy: { mandatory: false, timeoutMs: 1000 } }] }).checks[0]!;
  const run = (r: ArchitectureRules | undefined, edges: Edge[], changed: string[]) => runCheck({ definition: def, plugin: architecturePlugin({ rules: r, changedFiles: async () => changed, readEdges: async () => edges }), sourceSha: 'c'.repeat(40), scope: 's', artifactDigest: 'x', workerProfile: 'w', now: () => NOW });

  it('with no rules configured it is NOT_APPLICABLE through planning, never a pass', async () => {
    expect(planArchitectureCheck(undefined)).toMatchObject({ action: 'not-applicable', reason: 'ecosystem-absent' });
    expect(architectureNotApplicable({ name: 'architecture', version: '1', digest: DIGEST })).toMatchObject({ status: 'not-applicable', execution: 'not-run' });
    expect(planArchitectureCheck(rules).action).toBe('run');
    expect((await run(undefined, [], [])).result.status).toBe('unknown'); // a plugin run with no rules is not a clean result
  });

  it('a new violation is a quality-debt finding that blocks only per policy; baselined violations stay visible without blocking', async () => {
    const old = await run(rules, [e('src/domain/old.ts', 'src/infra/db.ts')], ['src/domain/old.ts']);
    const baseline = baselineFrom(old.findings, new Date('2026-11-01T00:00:00Z'), 'alice');
    const both = await run(rules, [e('src/domain/old.ts', 'src/infra/db.ts'), e('src/domain/new.ts', 'src/ui/view.ts')], ['src/domain/old.ts', 'src/domain/new.ts']);
    expect(both.findings.every((f) => f.class === 'quality-debt')).toBe(true);
    const lenient = evaluateFindingGate({ findings: both.findings, baseline, now: NOW });
    expect(lenient.blocked).toBe(false);                       // default policy: quality debt does not block
    expect(lenient.visibleDebt.qualityDebt).toBe(1);           // the baselined one stays visible
    const strict = evaluateFindingGate({ findings: both.findings, baseline, now: NOW, policy: { blockSecurityAt: 'high', blockQualityDebtAt: 'high' } });
    expect(strict.blocked).toBe(true);
    expect(strict.blocking).toEqual([both.findings.find((f) => f.path === 'src/domain/new.ts')!.fingerprint]);  // only the new violation
  });

  it('is deterministic and a clean change passes', async () => {
    const a = await run(rules, [e('src/ui/a.ts', 'src/domain/b.ts')], ['src/ui/a.ts']);
    const b = await run(rules, [e('src/ui/a.ts', 'src/domain/b.ts')], ['src/ui/a.ts']);
    expect(a.result.status).toBe('pass');
    expect(a.findings).toEqual(b.findings);
  });
});
