import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeVerification } from './executor.ts';
import { createGodotVerificationAdapter } from './godot-adapter.ts';
import { checkGodotEnvironment, detectGodotCrash, godotDiagnosticFingerprint, godotEnvironmentHash, godotWorkerMatches, redactExcerpt, validateGodotProviderManifest, type GodotEnvironment, type GodotProviderManifest } from './godot-provider.ts';

const exec = promisify(execFile);
const fixtures = resolve(__dirname, '../../../../../tests/fixtures/godot-provider');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });
const manifest = async (): Promise<GodotProviderManifest> => JSON.parse(await readFile(join(fixtures, 'manifest.json'), 'utf8'));
const goodEnv: GodotEnvironment = { os: 'linux', engineVersion: 'Godot Engine v4.3.stable', gdunitVersion: '4.3.1', renderer: 'none', display: 'headless', mountedAssets: ['game-assets'] };

async function projectFrom(name: 'alpha' | 'beta', checkId: string, script: string) {
  const root = await mkdtemp(join(tmpdir(), `godot provider ${name} `));
  roots.push(root);
  await cp(join(fixtures, 'projects', name), root, { recursive: true });
  await mkdir(join(root, '.ai/factory'), { recursive: true });
  await writeFile(join(root, 'runner.js'), script);
  await writeFile(join(root, '.ai/factory/factory.config.yaml'), `verification:\n  version: 1\n  checks:\n    ${checkId}:\n      runner: command\n      executable: ${JSON.stringify(process.execPath)}\n      args: ["runner.js"]\n      cwd: .\n      timeoutSeconds: 10\n      optional: false\n  suites:\n    quick: [${checkId}]\n`);
  await exec('git', ['init', '-q'], { cwd: root });
  await exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '--allow-empty', '-qm', 'f'], { cwd: root });
  return root;
}
async function run(root: string, extra: Partial<Parameters<typeof createGodotVerificationAdapter>[0] & object> & { env?: GodotEnvironment } = {}) {
  const { env, ...rest } = extra;
  return executeVerification({ worktreePath: root, cezarRunId: 'r', projectId: 'p', suite: 'quick', adapter: createGodotVerificationAdapter({ provider: { manifest: await manifest(), environment: env ?? goodEnv }, ...rest }) });
}
const junit = (body: string) => `const fs=require('fs');fs.mkdirSync('reports',{recursive:true});fs.writeFileSync('reports/results.xml',${JSON.stringify(body)});`;
const ok = `<testsuites><testsuite tests="1"><testcase name="a"/></testsuite></testsuites>`;
const codes = (r: Awaited<ReturnType<typeof run>>) => r.run.checks[0]!.diagnostics.map((d) => d.code);

describe('godot provider manifest', () => {
  it('validates the shared manifest and rejects broken ones', async () => {
    const m = await manifest();
    expect(validateGodotProviderManifest(m)).toEqual({ valid: true, errors: [] });
    expect(validateGodotProviderManifest({ ...m, capabilities: ['nope'] }).valid).toBe(false);
    expect(validateGodotProviderManifest({ ...m, environmentHash: 'x' }).valid).toBe(false);
    expect(validateGodotProviderManifest(null).valid).toBe(false);
  });

  it('hashes the environment deterministically', () => {
    expect(godotEnvironmentHash(goodEnv)).toBe(godotEnvironmentHash({ ...goodEnv }));
    expect(godotEnvironmentHash(goodEnv)).not.toBe(godotEnvironmentHash({ ...goodEnv, engineVersion: '4.4' }));
  });

  it('reports environment problems separately and matches workers by capability', async () => {
    const m = await manifest();
    expect(checkGodotEnvironment(m, goodEnv)).toEqual([]);
    expect(godotWorkerMatches(m, goodEnv)).toBe(true);
    expect(checkGodotEnvironment(m, { ...goodEnv, mountedAssets: [] })[0]!.code).toBe('godot.asset-mount-missing');
    expect(checkGodotEnvironment(m, { ...goodEnv, engineVersion: '3.5' })[0]!.code).toBe('godot.engine-mismatch');
    expect(checkGodotEnvironment(m, { ...goodEnv, gdunitVersion: '3.0' })[0]!.code).toBe('godot.gdunit-mismatch');
    expect(checkGodotEnvironment(m, { ...goodEnv, os: 'macos' })[0]!.code).toBe('godot.os-mismatch');
    expect(godotWorkerMatches(m, { ...goodEnv, os: 'windows' })).toBe(true);
  });

  it('handles Linux and Windows exit codes and paths', () => {
    expect(detectGodotCrash('', 139)).toBe(true);
    expect(detectGodotCrash('', 3221225477)).toBe(true);
    expect(detectGodotCrash('ok', 1)).toBe(false);
    const a = godotDiagnosticFingerprint('error', 'ERROR: bad thing at C:\\Users\\bob\\proj\\a.gd:12');
    const b = godotDiagnosticFingerprint('error', 'ERROR: bad thing at /home/alice/proj/a.gd:99');
    expect(a).toBe(b);
    expect(godotDiagnosticFingerprint('warning', 'ERROR: bad thing at /home/alice/proj/a.gd:99')).not.toBe(a);
  });

  it('redacts secrets and home paths and bounds excerpts', () => {
    const out = redactExcerpt('token=abc123secret ghp_abcdefghijklmnopqrstuv Bearer abcdefghijklmnop /home/bob/x C:\\Users\\bob\\x');
    expect(out).not.toMatch(/abc123secret|ghp_abc|abcdefghijklmnop|bob/);
    expect(redactExcerpt('x'.repeat(5000)).length).toBeLessThan(2000);
  });
});

describe('godot provider reuse across two projects', () => {
  it.each(['alpha', 'beta'] as const)('runs project %s with the single provider and no core changes', async (name) => {
    const r = await run(await projectFrom(name, 'gdunit', junit(ok)));
    expect(r.run.status).toBe('passed');
  });

  it('separates known warning debt from a newly introduced error', async () => {
    const warn = 'WARNING: unused variable at res://a.gd:4';
    const fp = godotDiagnosticFingerprint('warning', warn);
    const debt = await run(await projectFrom('alpha', 'gdunit', `${junit(ok)}console.log(${JSON.stringify(warn)});process.exit(101)`), { provider: undefined });
    expect(debt.run.status).toBe('passed');
    const known = await run(await projectFrom('alpha', 'gdunit', `${junit(ok)}console.log(${JSON.stringify(warn)})`));
    expect(known.run.status).toBe('passed');
    const m = await manifest();
    const knownRun = await executeVerification({ worktreePath: await projectFrom('beta', 'gdunit', `${junit(ok)}console.log(${JSON.stringify(warn)})`), cezarRunId: 'r', projectId: 'p', suite: 'quick', adapter: createGodotVerificationAdapter({ provider: { manifest: m, environment: goodEnv, knownWarningFingerprints: [fp] } }) });
    expect(codes(knownRun)).toContain('godot.warning.known');
    expect(knownRun.run.status).toBe('passed');
    const err = await run(await projectFrom('alpha', 'gdunit', `${junit(ok)}console.log('SCRIPT ERROR: Invalid call at res://a.gd:9')`));
    expect(err.run.status).toBe('failed');
    expect(codes(err)).toContain('godot.error.new');
    expect(codes(err)).not.toContain('godot.warning.known');
  });

  it('treats a missing asset mount and version mismatch as infrastructure, without running', async () => {
    const root = await projectFrom('alpha', 'gdunit', `require('fs').writeFileSync('ran','1')`);
    const missing = await run(root, { env: { ...goodEnv, mountedAssets: [] } });
    expect(missing.run.status).toBe('infrastructure-error');
    expect(codes(missing)).toEqual(['godot.asset-mount-missing']);
    await expect(readFile(join(root, 'ran'))).rejects.toThrow();
    const mismatch = await run(await projectFrom('beta', 'gdunit', junit(ok)), { env: { ...goodEnv, engineVersion: '5.0' } });
    expect(codes(mismatch)).toEqual(['godot.engine-mismatch']);
  });

  it('keeps crash, timeout, parse error and malformed JUnit distinct', async () => {
    const crash = await run(await projectFrom('alpha', 'gdunit', `console.log('handle_crash: Program crashed with signal 11');process.exit(1)`));
    expect(crash.run.status).toBe('infrastructure-error');
    expect(codes(crash)).toEqual(['godot.crash']);
    const parse = await run(await projectFrom('alpha', 'godot-parse', `console.log('SCRIPT ERROR: Parse Error: bad\\n at: GDScript::reload (res://x.gd:3)')`));
    expect(parse.run.status).toBe('failed');
    expect(codes(parse)).toContain('godot.parse-error');
    const bad = await run(await projectFrom('beta', 'gdunit', junit('<testsuites><testsuite')));
    expect(bad.run.status).toBe('unknown');
    expect(codes(bad)).toContain('gdunit.malformed-xml');
    const slow = await projectFrom('alpha', 'gdunit', 'setTimeout(()=>{},60000)');
    const cfg = join(slow, '.ai/factory/factory.config.yaml');
    await writeFile(cfg, (await readFile(cfg, 'utf8')).replace('timeoutSeconds: 10', 'timeoutSeconds: 1'));
    const t = await run(slow);
    expect(t.run.status).toBe('infrastructure-error');
    expect(codes(t)).toEqual(['godot.runner-failure']);
  }, 30_000);
});
