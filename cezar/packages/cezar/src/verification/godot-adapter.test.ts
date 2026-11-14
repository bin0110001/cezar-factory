import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeVerification } from './executor.ts';
import { classifyGodotOutput, createGodotVerificationAdapter, godotCheckKind, parseJunit } from './godot-adapter.ts';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });

/** A fake "runner" script stands in for the existing TableFlux scripts; it is wrapped, never modified. */
async function project(checkId: string, script: string) {
  const root = await mkdtemp(join(tmpdir(), 'godot adapter '));
  roots.push(root);
  await mkdir(join(root, '.ai/factory'), { recursive: true });
  await writeFile(join(root, 'runner.js'), script);
  await writeFile(join(root, '.ai/factory/factory.config.yaml'), `verification:\n  version: 1\n  checks:\n    ${checkId}:\n      runner: command\n      executable: ${JSON.stringify(process.execPath)}\n      args: ["runner.js"]\n      cwd: .\n      timeoutSeconds: 10\n      optional: false\n  suites:\n    quick: [${checkId}]\n`);
  await exec('git', ['init', '-q'], { cwd: root });
  await exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '--allow-empty', '-qm', 'f'], { cwd: root });
  return root;
}
const run = (root: string) => executeVerification({ worktreePath: root, cezarRunId: 'r', projectId: 'p', suite: 'quick', adapter: createGodotVerificationAdapter() });
const junit = (body: string) => `const fs=require('fs');fs.mkdirSync('reports',{recursive:true});fs.writeFileSync('reports/results.xml',${JSON.stringify(body)});`;
const ok = `<testsuites><testsuite tests="2" failures="0"><testcase name="a"/><testcase name="b"/></testsuite></testsuites>`;

describe('godot adapter', () => {
  it('classifies check kinds and separates parse from editor errors', () => {
    expect(godotCheckKind('godot-parse')).toBe('parse');
    expect(godotCheckKind('tableflux-startup')).toBe('startup');
    expect(godotCheckKind('gdunit')).toBe('gdunit');
    const c = classifyGodotOutput('SCRIPT ERROR: Parse Error: Unexpected token\n          at: GDScript::reload (res://a/b.gd:12)\nERROR: Cannot open project in editor\nWARNING: odd');
    expect(c.parse).toHaveLength(1);
    expect(c.parse[0]).toMatchObject({ file: 'a/b.gd', line: 12 });
    expect(c.editor).toHaveLength(1);
    expect(c.warnings).toHaveLength(1);
  });

  it('fails a parse check that exits 0 but reported a parse error', async () => {
    const root = await project('godot-parse', `console.log('SCRIPT ERROR: Parse Error: bad\\n at: GDScript::reload (res://x.gd:3)')`);
    const r = await run(root);
    expect(r.run.status).toBe('failed');
    expect(r.run.semanticExitCode).toBe(1);
    expect(r.run.checks[0]!.diagnostics[0]!.code).toBe('godot.parse-error');
  });

  it('does not report editor errors as a pass or as a parse failure', async () => {
    const root = await project('godot-parse', `console.log('ERROR: Cannot open project in editor')`);
    const r = await run(root);
    expect(r.run.status).toBe('infrastructure-error');
    expect(r.run.checks[0]!.diagnostics[0]!.code).toBe('godot.editor-error');
  });

  it('passes a clean startup check unchanged', async () => {
    const r = await run(await project('tableflux-startup', `console.log('startup ok')`));
    expect(r.run.status).toBe('passed');
  });

  it('ingests JUnit, keeps the raw artifact and executes once', async () => {
    const root = await project('gdunit', `${junit(ok)}`);
    const r = await run(root);
    expect(r.run.status).toBe('passed');
    expect(r.run.checks).toHaveLength(1);
    expect(r.run.checks[0]!.artifacts[0]).toMatchObject({ path: 'reports/results.xml', mediaType: 'application/xml' });
  });

  it('fails on JUnit failures even when the runner exits 0, and on exit 100', async () => {
    const bad = `<testsuite tests="1"><testcase name="a"><failure message="x"/></testcase></testsuite>`;
    expect((await run(await project('gdunit', junit(bad)))).run.status).toBe('failed');
    expect((await run(await project('gdunit', `${junit(ok)}process.exit(100)`))).run.status).toBe('failed');
  });

  it('keeps warning semantics (exit 101 passes with a warning diagnostic)', async () => {
    const r = await run(await project('gdunit', `${junit(ok)}process.exit(101)`));
    expect(r.run.status).toBe('passed');
    expect(r.run.checks[0]!.diagnostics.some((d) => d.code === 'gdunit.warnings')).toBe(true);
  });

  it('treats empty, skipped, missing and malformed results as incomplete, never a pass', async () => {
    expect((await run(await project('gdunit', junit('<testsuites><testsuite tests="0"></testsuite></testsuites>')))).run.status).toBe('no-tests');
    expect((await run(await project('gdunit', junit('<testsuite tests="1"><testcase name="a"><skipped/></testcase></testsuite>')))).run.status).toBe('skipped');
    expect((await run(await project('gdunit', `console.log('x')`))).run.status).toBe('unknown');
    const malformed = await run(await project('gdunit', junit('<testsuites><testsuite')));
    expect(malformed.run.status).toBe('unknown');
    expect(malformed.run.semanticExitCode).not.toBe(0);
    expect(parseJunit('<nope/>')).toBeUndefined();
  });

  it('keeps concurrent worktrees isolated (per-worktree artifacts)', async () => {
    const [a, b] = await Promise.all([project('gdunit', junit(ok)), project('gdunit', junit(ok))]);
    const [ra, rb] = await Promise.all([run(a), run(b)]);
    expect(ra.artifactPath).not.toBe(rb.artifactPath);
    expect(ra.run.status).toBe('passed');
    expect(rb.run.status).toBe('passed');
  });
});
