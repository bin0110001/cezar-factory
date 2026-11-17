import { describe, expect, it } from 'vitest';
import { checkProviderConfigSchema, type CheckCategory } from '../check-provider.js';
import { evaluateGates, type CheckRunRecord } from '../check-gates.js';
import { CheckResultCache, runCheck, type CheckProviderPlugin } from '../check-runner.js';
import { BUILTIN_PROFILES, detectEcosystems, notApplicableResult, planChecks } from '../capabilities.js';
import { godotCheckPlugin } from './godot-check-adapter.js';
import { nativeLintPlugin, parseEslint, parseRuff, parseTsc } from './native-lint-adapter.js';
import { buildSemgrepArgv, rulesetDigest, semgrepPlugin, type RulesetSource } from './semgrep-adapter.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const SHA = 'c'.repeat(40);
const NOW = new Date('2026-11-16T12:00:00Z');
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

function def(name: string, category: CheckCategory, over: Record<string, unknown> = {}, policy: Record<string, unknown> = {}) {
  return checkProviderConfigSchema.parse({ version: 1, checks: [{
    id: `${name}-${category}`, category, provider: { name, version: '1.0.0', digest: DIGEST }, scopes: ['changed-files'], triggers: ['pr-dev'],
    policy: { mandatory: true, timeoutMs: 1000, cache: { enabled: true, ttlHours: 24 }, ...policy }, ...over,
  }] }).checks[0]!;
}
const run = (d: ReturnType<typeof def>, plugin: CheckProviderPlugin, extra: Record<string, unknown> = {}) =>
  runCheck({ definition: d, plugin, sourceSha: SHA, scope: 's', artifactDigest: 'x', workerProfile: 'w', now: () => NOW, secrets: [SECRET], ...extra });
const gate = (category: CheckCategory, o: Awaited<ReturnType<typeof run>>, id: string) => {
  const rec: CheckRunRecord = { checkId: id, category, result: o.result, sourceSha: SHA, finishedAt: NOW.toISOString(), findings: o.findings };
  return evaluateGates([{ category, mandatory: true, maxAgeHours: 24 }], [rec], { sourceSha: SHA, now: NOW });
};

describe('Semgrep adapter', () => {
  const rulesets: RulesetSource[] = [{ id: 'team-rules', path: '/rules/team.yml', digest: `sha256:${'1'.repeat(64)}` }];
  const sarif = (extra = '') => JSON.stringify({ runs: [{ tool: { driver: { rules: [{ id: 'js.insecure-eval', properties: { severity: 'ERROR' } }] } },
    results: [{ ruleId: 'js.insecure-eval', level: 'error', message: { text: `eval of user input ${extra} CWE-95` }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/app.ts' }, region: { startLine: 7 } } }] }] }] });
  const make = (over: { digest?: string | undefined; stdout?: string; exitCode?: number; supported?: number; sources?: RulesetSource[] } = {}) => {
    const sources = over.sources ?? rulesets;
    let execs = 0;
    const plugin = semgrepPlugin({
      target: '/src', rulesets: sources,
      readRulesetDigest: async (r) => ('digest' in over ? over.digest : r.digest),
      countSupportedFiles: async () => over.supported ?? 3,
      exec: async () => { execs++; return { exitCode: over.exitCode ?? 1, stdout: over.stdout ?? sarif() }; },
    });
    return { plugin, execs: () => execs };
  };
  const d = def('semgrep', 'sast');

  it('a finding in a supported file becomes a normalized sast finding blocked at the gate, with ruleset provenance', async () => {
    const o = await run(d, make().plugin);
    expect(o.result).toMatchObject({ status: 'fail', blockingFindingCount: 1 });
    expect(o.findings[0]).toMatchObject({ category: 'sast', path: 'src/app.ts', line: 7, severity: 'high', commonIds: { cwe: ['CWE-95'] } });
    expect(o.provenance.inputsDigest).toBe(rulesetDigest(rulesets));
    expect(gate('sast', o, d.id).allowed).toBe(false);
  });

  it('changing a ruleset misses the cache; the same ruleset hits it', async () => {
    const cache = new CheckResultCache();
    const m = make({ exitCode: 0, stdout: JSON.stringify({ runs: [{ results: [] }] }) });
    await run(d, m.plugin, { cache });
    expect((await run(d, m.plugin, { cache })).cacheHit).toBe(true);
    expect(m.execs()).toBe(1);
    const changed: RulesetSource[] = [{ ...rulesets[0]!, digest: `sha256:${'2'.repeat(64)}` }];
    const m2 = make({ sources: changed, exitCode: 0, stdout: JSON.stringify({ runs: [{ results: [] }] }) });
    expect((await run(d, m2.plugin, { cache })).cacheHit).toBe(false);
  });

  it('unavailable or tampered rules are an error, never a pass', async () => {
    expect((await run(d, make({ digest: undefined }).plugin)).result).toMatchObject({ status: 'error', execution: 'failed' });
    const mismatch = await run(d, make({ digest: `sha256:${'9'.repeat(64)}` }).plugin);
    expect(mismatch.result.status).toBe('error');
    expect(mismatch.result.reason).toMatch(/does not match its pin/);
  });

  it('unsupported language reports unknown with a reason (planning decides NOT_APPLICABLE), and crashes are errors', async () => {
    const none = make({ supported: 0 });
    const o = await run(d, none.plugin);
    expect(o.result).toMatchObject({ status: 'unknown', execution: 'not-run' });
    expect(none.execs()).toBe(0);
    expect((await run(d, make({ exitCode: 2 }).plugin)).result.status).toBe('error');
    expect((await run(d, make({ stdout: 'oops' }).plugin)).result.status).toBe('error');
  });

  it('requires pinned rulesets and redacts secrets in findings', async () => {
    expect(() => buildSemgrepArgv({ target: '/src', rulesets: [] })).toThrow(/pinned ruleset/);
    const argv = buildSemgrepArgv({ target: '/src', rulesets });
    expect(argv).toEqual(expect.arrayContaining(['--metrics=off', '--config', '/rules/team.yml']));
    expect(argv.slice(-2)).toEqual(['--', '/src']);
    const o = await run(d, make({ stdout: sarif(SECRET) }).plugin);
    expect(JSON.stringify(o)).not.toContain(SECRET);
  });
});

describe('native lint adapters', () => {
  const eslintOut = JSON.stringify([{ filePath: '/repo/web/src/a.ts', messages: [{ ruleId: 'no-eval', severity: 2, message: 'eval is evil', line: 4 }, { ruleId: 'semi', severity: 1, message: 'missing semicolon', line: 9 }] }]);
  const tscOut = 'web/src/a.ts(3,5): error TS2322: Type string is not assignable to number.\nnoise line\n';
  const ruffOut = JSON.stringify([{ code: 'E501', message: 'line too long', filename: '/repo/tools/b.py', location: { row: 12, column: 1 } }]);
  const csharp = JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'csc', rules: [{ id: 'CS0103', properties: {} }] } }, results: [{ ruleId: 'CS0103', level: 'error', message: { text: "The name 'x' does not exist" }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/Program.cs' }, region: { startLine: 21 } } }] }] }] });

  it('parses each tool and strips the repository root', () => {
    expect(parseEslint(eslintOut, '/repo').document).toMatchObject({ findings: [{ id: 'no-eval', severity: 'high', path: 'web/src/a.ts', line: 4 }, { id: 'semi', severity: 'low' }] });
    expect(parseTsc(tscOut).document).toMatchObject({ findings: [{ id: 'TS2322', path: 'web/src/a.ts', line: 3 }] });
    expect(parseRuff(ruffOut, '/repo').document).toMatchObject({ findings: [{ id: 'E501', path: 'tools/b.py', line: 12 }] });
    expect(() => parseEslint('{}')).toThrow();
  });

  it('demo TypeScript lint flows through runCheck and the gates with provider-neutral verdicts', async () => {
    const d = def('eslint', 'lint');
    const o = await run(d, nativeLintPlugin({ tool: 'eslint', targets: ['web'], root: '/repo', exec: async () => ({ exitCode: 1, stdout: eslintOut }) }));
    expect(o.result).toMatchObject({ status: 'fail', findingCount: 2, blockingFindingCount: 1 });
    const g = gate('lint', o, d.id);
    expect(g.allowed).toBe(false);
    expect(JSON.stringify(g)).not.toContain('eslint');
  });

  it('demo C# analyzers flow through the same path (SARIF) and a clean run passes', async () => {
    const d = def('dotnet', 'lint');
    const bad = await run(d, nativeLintPlugin({ tool: 'dotnet', targets: ['src/App.csproj'], exec: async () => ({ exitCode: 1, stdout: csharp }) }));
    expect(bad.findings[0]).toMatchObject({ path: 'src/Program.cs', line: 21, severity: 'high' });
    expect(gate('lint', bad, d.id).allowed).toBe(false);
    const clean = await run(d, nativeLintPlugin({ tool: 'dotnet', targets: ['src/App.csproj'], exec: async () => ({ exitCode: 0, stdout: JSON.stringify({ runs: [{ results: [] }] }) }) }));
    expect(clean.result.status).toBe('pass');
  });

  it('warnings alone warn without blocking, and Python and tsc type errors are gated', async () => {
    const warnOnly = JSON.stringify([{ filePath: '/r/a.ts', messages: [{ ruleId: 'semi', severity: 1, message: 'm', line: 1 }] }]);
    const w = await run(def('eslint', 'lint'), nativeLintPlugin({ tool: 'eslint', targets: ['.'], exec: async () => ({ exitCode: 0, stdout: warnOnly }) }));
    expect(w.result.status).toBe('warn');
    expect(gate('lint', w, 'x').allowed).toBe(true);
    const py = await run(def('ruff', 'lint'), nativeLintPlugin({ tool: 'ruff', targets: ['.'], exec: async () => ({ exitCode: 1, stdout: ruffOut }) }));
    expect(py.result.status).toBe('fail');
    const ts = await run(def('tsc', 'type'), nativeLintPlugin({ tool: 'tsc', targets: [], exec: async () => ({ exitCode: 2, stdout: tscOut }) }));
    expect(ts.result.status).toBe('fail');
  });

  it('a tool crash or unparseable output is an error, never a pass', async () => {
    const d = def('eslint', 'lint');
    expect((await run(d, nativeLintPlugin({ tool: 'eslint', targets: ['.'], exec: async () => ({ exitCode: 2, stdout: '' }) }))).result.status).toBe('error');
    expect((await run(d, nativeLintPlugin({ tool: 'eslint', targets: ['.'], exec: async () => ({ exitCode: 0, stdout: 'not json' }) }))).result.status).toBe('error');
  });

  it('a project without the tool is NOT_APPLICABLE from planning and does not block a required lint gate', () => {
    const plan = planChecks(BUILTIN_PROFILES[0]!, detectEcosystems(['web/tsconfig.json', 'web/src/a.ts']), (t) => t !== 'eslint');
    const eslint = plan.find((c) => c.checkId === 'ts-lint')!;
    expect(eslint).toMatchObject({ action: 'not-applicable', reason: 'tool-missing' });
    const result = notApplicableResult(eslint, { name: 'planner', version: '1', digest: DIGEST });
    const rec: CheckRunRecord = { checkId: 'ts-lint', category: 'lint', result, sourceSha: SHA, finishedAt: NOW.toISOString(), findings: [] };
    expect(evaluateGates([{ category: 'lint', mandatory: true, maxAgeHours: 24 }], [rec], { sourceSha: SHA, now: NOW }).allowed).toBe(true);
  });
});

describe('Godot adapter', () => {
  const d = def('godot', 'lint');
  const exec = (output: string, exitCode = 0) => async () => ({ exitCode, output });
  const parseErr = 'SCRIPT ERROR: Parse Error: Expected expression after "="\n   at: GDScript::reload (res://scripts/player.gd:12)\n';

  it('a GDScript parse error is a blocking finding with its location', async () => {
    const o = await run(d, godotCheckPlugin({ projectPath: '/game', exec: exec(parseErr, 1) }));
    expect(o.result).toMatchObject({ status: 'fail', blockingFindingCount: 1 });
    expect(o.findings[0]).toMatchObject({ path: 'scripts/player.gd', line: 12, severity: 'high' });
    expect(gate('lint', o, d.id).allowed).toBe(false);
  });

  it('warnings are quality debt: they warn and do not block', async () => {
    const o = await run(d, godotCheckPlugin({ projectPath: '/game', exec: exec('WARNING: The variable "x" is declared but never used.\n') }));
    expect(o.result).toMatchObject({ status: 'warn', findingCount: 1, blockingFindingCount: 0 });
    expect(gate('lint', o, d.id).allowed).toBe(true);
  });

  it('a clean project passes; editor/start-up noise and silent failures are errors, not project verdicts', async () => {
    expect((await run(d, godotCheckPlugin({ projectPath: '/game', exec: exec('Godot Engine v4.3\n') }))).result.status).toBe('pass');
    const noise = await run(d, godotCheckPlugin({ projectPath: '/game', exec: exec("ERROR: Couldn't load project at path '/game'\n", 1) }));
    expect(noise.result).toMatchObject({ status: 'error', execution: 'failed' });
    expect((await run(d, godotCheckPlugin({ projectPath: '/game', exec: exec('', 139) }))).result.status).toBe('error');
  });

  it('no Godot binary is NOT_APPLICABLE from capability planning, found by name and never by path', () => {
    const asked: string[] = [];
    const plan = planChecks(BUILTIN_PROFILES[1]!, detectEcosystems(['project.godot', 'a.gd']), (t) => { asked.push(t); return false; });
    expect(plan.find((c) => c.checkId === 'gdscript-parse')).toMatchObject({ action: 'not-applicable', reason: 'tool-missing' });
    expect(asked).toContain('godot');
    expect(asked.every((t) => !t.includes('/') && !t.includes('\\'))).toBe(true);
  });
});
