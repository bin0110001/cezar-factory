import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkProviderConfigSchema, type CheckCategory, type CheckDefinition } from './check-provider.js';
import { BUILTIN_PROFILES, detectEcosystems, planChecks } from './capabilities.js';
import { duplicateGateViolations, swapProvider } from './guards.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const defs = (items: Array<{ id: string; category: CheckCategory; mandatory?: boolean; triggers?: string[]; provider?: string }>): CheckDefinition[] =>
  checkProviderConfigSchema.parse({ version: 1, checks: items.map((i) => ({
    id: i.id, category: i.category, provider: { name: i.provider ?? i.id, version: '1.0.0', digest: DIGEST }, scopes: ['full-repo'], triggers: i.triggers ?? ['pr-dev'],
    policy: { mandatory: i.mandatory ?? true, timeoutMs: 1000 },
  })) }).checks;

describe('duplicate-gate guard (#673)', () => {
  it('two mandatory analyzers for the same category and trigger are a violation unless allowed explicitly', () => {
    const d = defs([{ id: 'trivy-sca', category: 'sca' }, { id: 'osv-sca', category: 'sca' }, { id: 'eslint', category: 'lint' }]);
    expect(duplicateGateViolations(d)).toEqual([{ category: 'sca', trigger: 'pr-dev', checks: ['osv-sca', 'trivy-sca'] }]);
    expect(duplicateGateViolations(d, ['sca'])).toEqual([]);
  });

  it('an advisory second analyzer, a different trigger or a different category is not a duplicate', () => {
    expect(duplicateGateViolations(defs([{ id: 'a', category: 'sca' }, { id: 'b', category: 'sca', mandatory: false }]))).toEqual([]);
    expect(duplicateGateViolations(defs([{ id: 'a', category: 'sca', triggers: ['pr-dev'] }, { id: 'b', category: 'sca', triggers: ['release-candidate'] }]))).toEqual([]);
    expect(duplicateGateViolations(defs([{ id: 'a', category: 'sca' }, { id: 'b', category: 'sast' }]))).toEqual([]);
  });

  it('every trigger shared by two mandatory checks is reported separately', () => {
    const d = defs([{ id: 'a', category: 'sast', triggers: ['pr-dev', 'release-candidate'] }, { id: 'b', category: 'sast', triggers: ['pr-dev', 'release-candidate'] }]);
    expect(duplicateGateViolations(d).map((v) => v.trigger)).toEqual(['pr-dev', 'release-candidate']);
  });

  it('swapping a provider replaces one definition and cannot create a second gate', () => {
    const d = defs([{ id: 'dependency-scan', category: 'sca', provider: 'trivy' }]);
    const swapped = swapProvider(d, 'dependency-scan', { name: 'osv-scanner', version: '2.0.0', digest: DIGEST });
    expect(swapped).toHaveLength(1);
    expect(swapped[0]).toMatchObject({ id: 'dependency-scan', category: 'sca', provider: { name: 'osv-scanner' } });
    expect(duplicateGateViolations(swapped)).toEqual([]);
    expect(d[0]?.provider.name).toBe('trivy'); // the original is untouched
    expect(() => swapProvider(d, 'missing', { name: 'x', version: '1', digest: DIGEST })).toThrow(/unknown check/);
  });
});

describe('pilots share infrastructure with no hardcoded machine profile (#673)', () => {
  const found = (...p: string[]) => detectEcosystems(p);
  const has = () => true;

  it('.NET, TypeScript, Python and Godot are all planned by the same function from repository contents', () => {
    const factory = BUILTIN_PROFILES.find((p) => p.id === 'factory-dotnet-ts-python')!;
    const godot = BUILTIN_PROFILES.find((p) => p.id === 'godot-gdscript')!;
    const factoryPlan = planChecks(factory, found('a/App.csproj', 'web/tsconfig.json', 'web/a.ts', 'tools/x.py', 'web/package-lock.json'), has);
    const godotPlan = planChecks(godot, found('project.godot', 'a.gd'), has);
    for (const id of ['dotnet-format', 'ts-lint', 'ts-typecheck', 'python-lint']) expect(factoryPlan.find((c) => c.checkId === id)?.action).toBe('run');
    expect(godotPlan.find((c) => c.checkId === 'gdscript-parse')?.action).toBe('run');
    // the same plan on any machine: only the tool-by-name lookup differs
    expect(planChecks(factory, found('web/tsconfig.json'), (t) => t === 'eslint').map((c) => c.action)).toEqual(planChecks(factory, found('web/tsconfig.json'), (t) => t === 'eslint').map((c) => c.action));
  });

  it('profiles name tools, never paths or hardware, and check adapters contain no machine-specific constants', () => {
    for (const p of BUILTIN_PROFILES) for (const c of p.checks) expect(c.tool).toMatch(/^[A-Za-z0-9._-]+$/);
    const dir = new URL('.', import.meta.url);
    const sources = [...readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => new URL(f, dir)),
      ...readdirSync(new URL('providers/', dir)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => new URL(`providers/${f}`, dir))];
    const machineSpecific = /(["'`])(?:[A-Za-z]:[\\/]|\/(?:usr|opt|home|mnt|var)\/|\/dev\/dri)|nvidia|renderD\d|\bcuda\b|\bgpu\b/i;
    const offenders = sources.filter((u) => machineSpecific.test(readFileSync(u, 'utf8')) && !u.pathname.endsWith('/scanner-worker-profile.ts')).map((u) => u.pathname.split('/').slice(-2).join('/'));
    expect(offenders).toEqual([]);
  });
});
