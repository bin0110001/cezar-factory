import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkProviderConfigSchema } from '../check-provider.js';
import { CheckResultCache, runCheck } from '../check-runner.js';
import { baselineFrom, evaluateFindingGate } from '../finding-policy.js';
import {
  DEFAULT_MANIFEST, GodotEnvironmentError, buildGdUnitArgv, buildImportArgv, environmentHash, godotProjectConfigSchema, godotProvider, godotProviderManifestSchema,
  matchWorker, normalizeGodotOutput, validateResourceRefs, type GodotExecResult, type GodotProjectConfig, type WorkerCapabilities,
} from './godot-provider.js';

const NOW = new Date('2026-11-16T12:00:00Z');
const DIGEST = `sha256:${'a'.repeat(64)}`;
const worker = (over: Partial<WorkerCapabilities> = {}): WorkerCapabilities => ({ engineVersion: '4.3.1', gdunitVersion: '4.4.0', renderer: 'none', display: 'headless', os: 'linux', ...over });
const project = (over: Partial<GodotProjectConfig> = {}): GodotProjectConfig => godotProjectConfigSchema.parse({ projectDir: '/work/game', suites: ['res://test'], ...over });
const def = checkProviderConfigSchema.parse({ version: 1, checks: [{ id: 'godot', category: 'lint', provider: { name: 'godot-verification', version: '1.0.0', digest: DIGEST }, scopes: ['full-repo'], triggers: ['pr-dev'], policy: { mandatory: true, timeoutMs: 1000, cache: { enabled: true, ttlHours: 24 } } }] }).checks[0]!;

const parseErr = 'SCRIPT ERROR: Parse Error: Expected expression\n   at: GDScript::reload (res://scripts/player.gd:12)\n';
const warn = (n: number) => `WARNING: The variable "x${n}" is declared but never used (line ${n}).\n`;
const junit = (failed: string[] = [], tests = 4) => `<testsuite tests="${tests}" failures="${failed.length}" errors="0" skipped="0">${failed.map((f) => `<testcase classname="res://test/player_test.gd" name="${f}"><failure message="${f} failed"/></testcase>`).join('')}</testsuite>`;

function run(opts: { w?: WorkerCapabilities; p?: GodotProjectConfig; importOut?: Partial<GodotExecResult>; suite?: Partial<GodotExecResult>; resources?: { files: Array<{ path: string; text: string }>; exists: (p: string) => boolean }; cache?: CheckResultCache } = {}) {
  let calls = 0;
  const plugin = godotProvider({
    project: opts.p ?? project(), worker: async () => opts.w ?? worker(), readResources: opts.resources ? async () => opts.resources! : undefined,
    exec: async (argv) => { calls++; return argv.includes('--import') ? { exitCode: 0, output: '', ...opts.importOut } : { exitCode: 0, output: '', junitXml: junit(), ...opts.suite }; },
  });
  return runCheck({ definition: def, plugin, sourceSha: 'c'.repeat(40), scope: 's', artifactDigest: 'x', workerProfile: 'w', now: () => NOW, cache: opts.cache }).then((o) => ({ ...o, calls: () => calls }));
}

describe('manifest and capability matching', () => {
  it('the default manifest is valid, versioned, and names no project or path', () => {
    expect(godotProviderManifestSchema.safeParse(DEFAULT_MANIFEST).success).toBe(true);
    expect(DEFAULT_MANIFEST).toMatchObject({ id: 'godot-verification', version: '1.0.0', requires: { renderer: 'none', display: 'headless' } });
    const src = readFileSync(new URL('./godot-provider.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/tableflux|C:\\|\/home\/|nvidia|cuda/i);
  });

  it('matches a compatible worker and reports every incompatibility with a reason', () => {
    expect(matchWorker(DEFAULT_MANIFEST, worker(), project())).toEqual([]);
    const reasons = (w: Partial<WorkerCapabilities>, p = project()) => matchWorker(DEFAULT_MANIFEST, worker(w), p).map((e) => e.reason);
    expect(reasons({ engineVersion: undefined })).toEqual(['engine-missing']);
    expect(reasons({ engineVersion: '3.5.2' })).toEqual(['engine-incompatible']);
    expect(reasons({ engineVersion: '5.0.0' })).toEqual(['engine-incompatible']);
    expect(reasons({ gdunitVersion: undefined })).toEqual(['gdunit-incompatible']);
    expect(reasons({ gdunitVersion: undefined }, project({ suites: [] }))).toEqual([]);   // GdUnit only matters when a project has suites
    const gfx = godotProviderManifestSchema.parse({ ...DEFAULT_MANIFEST, requires: { renderer: 'vulkan', display: 'x11' } });
    expect(matchWorker(gfx, worker(), project()).map((e) => e.reason)).toEqual(['renderer-unavailable', 'display-unavailable']);
  });

  it('a required asset mount that is absent is an environment problem, not a code regression', () => {
    const m = godotProviderManifestSchema.parse({ ...DEFAULT_MANIFEST, assetMounts: [{ name: 'art', required: true }, { name: 'audio', required: false }] });
    const problems = matchWorker(m, worker(), project({ mountsPresent: ['audio'] }));
    expect(problems.map((e) => e.reason)).toEqual(['missing-asset-mount']);
    expect(problems[0]!.message).toContain('not a code regression');
    expect(matchWorker(m, worker(), project({ mountsPresent: ['art'] }))).toEqual([]);
  });

  it('the environment hash changes with the engine, os, renderer and mounts, and not with their order', () => {
    const base = environmentHash(DEFAULT_MANIFEST, worker(), project({ mountsPresent: ['a', 'b'] }));
    expect(environmentHash(DEFAULT_MANIFEST, worker(), project({ mountsPresent: ['b', 'a'] }))).toBe(base);
    for (const w of [{ engineVersion: '4.4.0' }, { os: 'windows' }, { renderer: 'opengl' as const }]) expect(environmentHash(DEFAULT_MANIFEST, worker(w), project({ mountsPresent: ['a', 'b'] }))).not.toBe(base);
    expect(environmentHash(DEFAULT_MANIFEST, worker(), project({ mountsPresent: ['a'] }))).not.toBe(base);
  });
});

describe('normalization', () => {
  it('a known warning and a new parse error have separate fingerprints and outcomes', () => {
    const n = normalizeGodotOutput(parseErr + warn(3));
    expect(n.findings.map((f) => [f.id.split(':')[0], f.severity])).toEqual([['godot.parse-error', 'high'], ['godot.warning', 'low']]);
    expect(n.findings[0]!.id).toBe('godot.parse-error:scripts/player.gd');
    expect(n.findings[0]!.id).not.toBe(n.findings[1]!.id);
    // the same warning moving to another line keeps its identity, so known debt stays one finding...
    const sameWarning = (line: number) => normalizeGodotOutput(`WARNING: The variable "x" is declared but never used (line ${line}).\n`).findings[0]!.id;
    expect(sameWarning(3)).toBe(sameWarning(99));
    // ...while a different variable's warning is a new finding that a baseline does not cover
    expect(normalizeGodotOutput(warn(1)).findings[0]!.id).not.toBe(normalizeGodotOutput(warn(2)).findings[0]!.id);
  });

  it('excerpts are bounded and absolute paths are redacted', () => {
    const f = normalizeGodotOutput(`WARNING: failed to read /home/user/secret/project/file.gd ${'x'.repeat(500)}\n`).findings[0]!;
    expect(f.title).not.toContain('/home/user');
    expect(f.title.length).toBeLessThanOrEqual(300);
  });

  it('validates res:// references in scenes and resources', () => {
    const files = [{ path: 'scenes/main.tscn', text: '[ext_resource type="Texture2D" path="res://art/hero.png" id=1]\n[ext_resource path="res://art/missing.png" id=2]\n' }, { path: 'a.gd', text: 'path="res://nope"' }];
    const f = validateResourceRefs(files, (p) => p === 'art/hero.png');
    expect(f).toEqual([expect.objectContaining({ id: 'godot.missing-resource:art/missing.png', path: 'scenes/main.tscn', line: 2 })]);
  });

  it('argv builders are generic: engine by name, project dir from config', () => {
    expect(buildImportArgv(project())).toEqual(['godot', '--headless', '--path', '/work/game', '--import', '--quit']);
    expect(buildGdUnitArgv(project(), 'res://test')).toContain('GdUnitCmdTool.gd'.replace(/^/, 'res://addons/gdUnit4/bin/'));
  });
});

describe('through the check pipeline', () => {
  it('a parse error blocks, GdUnit failures are findings, warnings are quality debt, and a clean project passes', async () => {
    expect((await run()).result.status).toBe('pass');
    expect((await run({ importOut: { exitCode: 1, output: parseErr } })).result).toMatchObject({ status: 'fail', blockingFindingCount: 1 });
    const failing = await run({ suite: { exitCode: 100, junitXml: junit(['jump works']) } });
    expect(failing.findings[0]!.ruleId).toBe('godot.test-failure:res://test/player_test.gd.jump works');
    expect((await run({ importOut: { output: warn(1) } })).result.status).toBe('warn');
  });

  it('known warning debt is baselined and visible while a newly introduced error blocks', async () => {
    const old = await run({ importOut: { output: warn(1) + warn(2) } });
    const baseline = baselineFrom(old.findings, new Date('2026-11-01T00:00:00Z'), 'alice');
    const now = await run({ importOut: { exitCode: 1, output: warn(1) + warn(2) + parseErr } });
    const gate = evaluateFindingGate({ findings: now.findings, baseline, now: NOW, policy: { blockSecurityAt: 'high', blockQualityDebtAt: 'high' } });
    expect(gate.blocking).toHaveLength(1);
    expect(gate.verdicts.find((v) => v.fingerprint === gate.blocking[0])!.status).toBe('new');
    expect(gate.visibleDebt.qualityDebt).toBeGreaterThan(0);
  });

  it('infrastructure and environment problems are errors with a reason, never findings or a pass', async () => {
    const cases: Array<[string, Parameters<typeof run>[0]]> = [
      ['no engine', { w: worker({ engineVersion: undefined }) }],
      ['incompatible engine', { w: worker({ engineVersion: '3.5.0' }) }],
      ['import timeout', { importOut: { timedOut: true } }],
      ['suite timeout', { suite: { timedOut: true } }],
      ['startup failure', { importOut: { exitCode: 1, output: "ERROR: Couldn't load project at path '/work/game'\n" } }],
      ['test crash with no report', { suite: { exitCode: 139, junitXml: undefined } }],
      ['failures with no report', { suite: { exitCode: 100, junitXml: undefined } }],
    ];
    for (const [name, o] of cases) {
      const r = await run(o);
      expect(r.result, name).toMatchObject({ status: 'error', execution: 'failed' });
      expect(r.findings, name).toEqual([]);
    }
    const missing = await run({ p: project({ mountsPresent: [] }), w: worker() });
    expect(missing.result.status).toBe('pass'); // the default manifest declares no required mount
  });

  it('a missing required asset mount fails as an environment error with that reason', async () => {
    const plugin = godotProvider({ manifest: godotProviderManifestSchema.parse({ ...DEFAULT_MANIFEST, assetMounts: [{ name: 'art', required: true }] }), project: project(), worker: async () => worker(), exec: async () => ({ exitCode: 0, output: '', junitXml: junit() }) });
    const r = await runCheck({ definition: def, plugin, sourceSha: 'c'.repeat(40), scope: 's', artifactDigest: 'x', workerProfile: 'w', now: () => NOW });
    expect(r.result).toMatchObject({ status: 'error' });
    expect(r.result.reason).toContain('not a code regression');
    expect(r.findings).toEqual([]);
  });

  it('two distinct Godot projects use one provider and manifest, with only their own suites and exclusions differing', async () => {
    const a = await run({ p: project({ projectDir: '/work/alpha', suites: ['res://tests/unit'] }) });
    const b = await run({ p: project({ projectDir: '/work/beta', suites: ['res://spec', 'res://integration'], exclusions: ['addons/**'] }) });
    expect(a.result.provider).toEqual(b.result.provider);
    expect([a.result.status, b.result.status]).toEqual(['pass', 'pass']);
    expect(a.provenance.inputsDigest).not.toBe(b.provenance.inputsDigest);   // their environment hashes differ with their own config
    expect(b.calls()).toBe(3);                                                // one import plus two project-owned suites
  });

  it('the environment hash is provenance and changes the cache key', async () => {
    const cache = new CheckResultCache();
    const first = await run({ cache });
    expect(first.provenance.inputsDigest).toMatch(/^sha256:/);
    const other = await run({ cache, w: worker({ engineVersion: '4.4.0' }) });
    expect(other.cacheHit).toBe(false);
  });

  it('exposes the typed error so callers can tell environment from code', () => {
    expect(new GodotEnvironmentError('timeout', 'x').reason).toBe('timeout');
  });
});
