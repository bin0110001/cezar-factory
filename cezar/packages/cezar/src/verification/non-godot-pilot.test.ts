import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { executeVerification } from './executor.ts';

/**
 * Non-Godot pilot (#115): a .NET-shaped project is verified end to end through the generic contract only, and a lint keeps Godot-specific
 * identifiers out of the core verification modules. The only Godot code lives in the named adapter (`godot-adapter.ts`) and the visual-evidence
 * fixture that deliberately exercises it; everything else must stay engine-agnostic.
 */

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const contractDir = join(here, '../../../contract/src');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const GODOT = /godot|gdunit|gdscript|\.tscn\b|\.gd\b|\.import\b/i;
/** Modules that are not an adapter and not an adapter fixture: they must work for any engine. */
const ADAPTER_OR_FIXTURE = new Set(['godot-adapter.ts', 'visual-evidence-fixtures.ts']);
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('core verification modules stay engine-agnostic (#115)', () => {
  it('has no Godot identifier in executable code outside the named adapter and its fixture', async () => {
    const core = (await readdir(here)).filter((f) => /\.(ts|mjs)$/.test(f) && !f.endsWith('.test.ts') && !ADAPTER_OR_FIXTURE.has(f));
    expect(core.length).toBeGreaterThan(15);
    const leaks: string[] = [];
    for (const file of core) {
      const code = stripComments(await readFile(join(here, file), 'utf8'));
      code.split('\n').forEach((line, i) => { if (GODOT.test(line)) leaks.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`); });
    }
    expect(leaks).toEqual([]);
  });

  it('keeps the generic verification contract free of Godot identifiers', async () => {
    const files = (await readdir(contractDir)).filter((f) => /^verification.*\.ts$/.test(f) && !f.endsWith('.test.ts'));
    expect(files).toContain('verification.ts');
    for (const file of files) expect(stripComments(await readFile(join(contractDir, file), 'utf8')), file).not.toMatch(GODOT);
  });

  it('the lint itself would catch a leak', () => {
    expect(GODOT.test('const runner = "res://scenes/main.tscn"')).toBe(true);
    expect(GODOT.test('verifyProject(dotnet)')).toBe(false);
    expect(stripComments('// godot only in a comment\nconst a = 1')).not.toMatch(GODOT);
  });
});

async function dotnetProject(label: string, testExit: number, summary: string) {
  const root = await mkdtemp(join(tmpdir(), `dotnet pilot ${label} `));
  roots.push(root);
  await mkdir(join(root, '.ai/factory'), { recursive: true });
  await mkdir(join(root, 'tests'), { recursive: true });
  // The "dotnet test" stand-in: the pilot proves the schema and executor path, not the .NET toolchain.
  const script = `process.stdout.write(${JSON.stringify(summary)}); process.exit(${testExit})`;
  await writeFile(join(root, 'tests', 'run-dotnet-tests.cjs'), script);
  await writeFile(join(root, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk"></Project>\n');
  await writeFile(join(root, '.ai/factory/factory.config.yaml'), [
    'verification:', '  version: 1', '  checks:', '    unit:', '      runner: command', `      executable: ${JSON.stringify(process.execPath)}`,
    '      args: ["tests/run-dotnet-tests.cjs"]', '      cwd: .', '      timeoutSeconds: 10', '      optional: false', '  suites:', '    quick: [unit]', '',
  ].join('\n'));
  await exec('git', ['init', '-q'], { cwd: root });
  await exec('git', ['add', '-A'], { cwd: root });
  await exec('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'pilot'], { cwd: root });
  return root;
}

describe('a .NET project verified through the generic path', () => {
  it('produces a valid passing result with no Godot-specific field or identifier', async () => {
    const root = await dotnetProject('pass', 0, 'Passed!  - Failed: 0, Passed: 12, Skipped: 0');
    const result = await executeVerification({ worktreePath: root, cezarRunId: 'pilot-pass', projectId: 'dotnet-pilot', suite: 'quick' });
    expect(result.run.status).toBe('passed');
    expect(result.run.checks.map((c) => c.id ?? c.checkId)).toContain('unit');
    const artifact = await readFile(result.artifactPath, 'utf8');
    expect(artifact).not.toMatch(GODOT);
    expect(JSON.parse(artifact).verificationId).toBe(result.run.verificationId);
  });

  it('reports a failing suite as failed through the same path, never as a pass', async () => {
    const root = await dotnetProject('fail', 1, 'Failed!  - Failed: 2, Passed: 10, Skipped: 0');
    const result = await executeVerification({ worktreePath: root, cezarRunId: 'pilot-fail', projectId: 'dotnet-pilot', suite: 'quick' });
    expect(result.run.status).toBe('failed');
    expect(result.run.semanticExitCode).not.toBe(0);
    expect(await readFile(result.artifactPath, 'utf8')).not.toMatch(GODOT);
  });
});
