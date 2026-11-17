import { describe, expect, it } from 'vitest';
import { checkResultSchema } from './check-provider.js';
import { evaluateGates, type CheckRunRecord } from './check-gates.js';
import {
  BUILTIN_PROFILES, checkProfileSchema, detectEcosystems, notApplicableResult, planChecks, selectProfile,
} from './capabilities.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const provider = { name: 'planner', version: '1', digest: DIGEST };
const SHA = 'c'.repeat(40);
const NOW = new Date('2026-11-16T12:00:00Z');

const factoryRepo = ['src/App.csproj', 'web/tsconfig.json', 'web/src/index.ts', 'tools/build.py', 'web/package-lock.json', 'Dockerfile'];
const godotRepo = ['project.godot', 'scripts/player.gd', 'addons/x/plugin.gd'];

describe('ecosystem detection', () => {
  it('detects from repository contents, ignoring vendored directories and declaration files', () => {
    const found = detectEcosystems(factoryRepo);
    expect([...found].sort()).toEqual(['container', 'dotnet', 'lockfile', 'python', 'typescript']);
    expect([...detectEcosystems(godotRepo)]).toEqual(['godot']);
    expect(detectEcosystems(['node_modules/x/index.ts', 'obj/a.csproj', 'types/a.d.ts', '.git/hooks/x.py']).size).toBe(0);
    expect(detectEcosystems(['C:\\proj\\main.tf']).has('iac')).toBe(true); // path separators are normalized
  });
});

describe('profiles', () => {
  it('built-in profiles are valid and have unique check ids', () => {
    for (const p of BUILTIN_PROFILES) expect(checkProfileSchema.safeParse(p).success).toBe(true);
    const dup = { ...BUILTIN_PROFILES[0], checks: [BUILTIN_PROFILES[0].checks[0], BUILTIN_PROFILES[0].checks[0]] };
    expect(checkProfileSchema.safeParse(dup).success).toBe(false);
    expect(checkProfileSchema.safeParse({ ...BUILTIN_PROFILES[0], checks: [{ ...BUILTIN_PROFILES[0].checks[0], tool: '/usr/bin/dotnet' }] }).success).toBe(false); // names, not paths
  });

  it('auto-selects the Factory profile for a .NET/TS/Python repo and the Godot profile for TableFlux-style repos', () => {
    expect(selectProfile('auto', detectEcosystems(factoryRepo)).id).toBe('factory-dotnet-ts-python');
    expect(selectProfile('auto', detectEcosystems(godotRepo)).id).toBe('godot-gdscript');
    expect(selectProfile('godot-gdscript', new Set()).id).toBe('godot-gdscript');
    expect(() => selectProfile('auto', new Set())).toThrow(/no check profile matches/);
    expect(() => selectProfile('nope', new Set())).toThrow(/unknown check profile/);
  });
});

describe('planning', () => {
  const all = () => true;

  it('selects the expected adapters for the Factory and Godot profiles', () => {
    const factory = planChecks(selectProfile('auto', detectEcosystems(factoryRepo)), detectEcosystems(factoryRepo), all);
    expect(factory.filter((c) => c.action === 'run').map((c) => c.checkId)).toEqual(['dotnet-format', 'dotnet-build-analyzers', 'ts-lint', 'ts-typecheck', 'python-lint', 'dependency-scan', 'sast-scan']);
    const godot = planChecks(selectProfile('auto', detectEcosystems(godotRepo)), detectEcosystems(godotRepo), all);
    expect(godot.find((c) => c.checkId === 'gdscript-parse')?.action).toBe('run');
    expect(godot.find((c) => c.checkId === 'dependency-scan')).toMatchObject({ action: 'not-applicable', reason: 'ecosystem-absent' });
  });

  it('a project lacking a language needs no scanner for it: NOT_APPLICABLE with a reason', () => {
    const plan = planChecks(BUILTIN_PROFILES[0], detectEcosystems(['web/tsconfig.json', 'web/src/a.ts']), all);
    expect(plan.find((c) => c.checkId === 'dotnet-format')).toMatchObject({ action: 'not-applicable', reason: 'ecosystem-absent' });
    expect(plan.find((c) => c.checkId === 'python-lint')?.action).toBe('not-applicable');
    expect(plan.find((c) => c.checkId === 'ts-lint')?.action).toBe('run');
  });

  it('a missing tool is NOT_APPLICABLE and distinguishable from a missing language; detection never assumes a path', () => {
    const found = detectEcosystems(godotRepo);
    const asked: string[] = [];
    const plan = planChecks(BUILTIN_PROFILES[1], found, (name) => { asked.push(name); return false; });
    expect(plan[0]).toMatchObject({ action: 'not-applicable', reason: 'tool-missing' });
    expect(asked).toEqual(['godot']);
  });
});

describe('NOT_APPLICABLE semantics', () => {
  const plan = planChecks(BUILTIN_PROFILES[1], new Set(['godot']), () => false)[0];

  it('produces a contract-valid result that is never run, has no findings and carries its reason', () => {
    const r = notApplicableResult(plan, provider);
    expect(checkResultSchema.safeParse(r).success).toBe(true);
    expect(r).toMatchObject({ status: 'not-applicable', execution: 'not-run', findingCount: 0 });
    expect(r.reason).toMatch(/tool-missing/);
    expect(() => notApplicableResult({ ...plan, action: 'run' }, provider)).toThrow();
  });

  it('cannot be forged from a run: not-applicable with execution or findings or no reason is rejected', () => {
    const base = notApplicableResult(plan, provider);
    expect(checkResultSchema.safeParse({ ...base, execution: 'completed' }).success).toBe(false);
    expect(checkResultSchema.safeParse({ ...base, findingCount: 1 }).success).toBe(false);
    expect(checkResultSchema.safeParse({ ...base, reason: undefined }).success).toBe(false);
  });

  it('is non-blocking at a required gate, distinct from unknown and error', () => {
    const rec = (status: 'not-applicable' | 'unknown' | 'error'): CheckRunRecord => ({
      checkId: 'x', category: 'lint', sourceSha: SHA, finishedAt: NOW.toISOString(), findings: [],
      result: status === 'not-applicable' ? notApplicableResult(plan, provider)
        : { checkId: 'x', provider, status, execution: status === 'error' ? 'failed' : 'completed', feed: 'unavailable', findingCount: 0, blockingFindingCount: 0 },
    });
    const req = [{ category: 'lint' as const, mandatory: true, maxAgeHours: 24 }];
    const ev = (r: CheckRunRecord) => evaluateGates(req, [r], { sourceSha: SHA, now: NOW });
    expect(ev(rec('not-applicable'))).toMatchObject({ allowed: true, verdicts: [{ status: 'not-applicable', satisfied: true }] });
    expect(ev(rec('unknown')).allowed).toBe(false);
    expect(ev(rec('error')).allowed).toBe(false);
  });
});
