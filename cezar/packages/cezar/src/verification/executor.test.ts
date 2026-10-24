import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeVerification, type VerificationAdapter } from './executor.ts';

const exec = promisify(execFile);
const roots: string[] = [];

async function fixture(label: string) {
  const root = await mkdtemp(join(tmpdir(), `verification ${label} `));
  roots.push(root);
  await mkdir(join(root, '.ai/factory'), { recursive: true });
  await writeFile(join(root, '.ai/factory/factory.config.yaml'), `verification:\n  version: 1\n  checks:\n    check:\n      runner: command\n      executable: ${JSON.stringify(process.execPath)}\n      args: ["-e", ${JSON.stringify('process.stdout.write("ok")')}]\n      cwd: .\n      timeoutSeconds: 5\n      optional: false\n  suites:\n    quick: [check]\n`);
  await exec('git', ['init', '-q'], { cwd: root });
  await exec('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: root });
  return root;
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('generic verification executor', () => {
  it('runs in a spaced worktree, writes a unique contract-validated artifact and records provenance', async () => {
    const root = await fixture('success');
    const [first, second] = await Promise.all([
      executeVerification({ worktreePath: root, cezarRunId: 'run-a', projectId: 'project', suite: 'quick' }),
      executeVerification({ worktreePath: root, cezarRunId: 'run-b', projectId: 'project', suite: 'quick' }),
    ]);
    const { stdout: headSha } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
    expect(first.run.status).toBe('passed');
    expect(first.run.commitSha).toBe(headSha.trim());
    expect(first.artifactPath).not.toBe(second.artifactPath);
    expect(JSON.parse(await readFile(first.artifactPath, 'utf8')).verificationId).toBe(first.run.verificationId);
  });

  it('classifies no-tests as incomplete and never as a pass', async () => {
    const root = await fixture('no-tests');
    const config = join(root, '.ai/factory/factory.config.yaml');
    const value = (await readFile(config, 'utf8')).replace('process.stdout.write(\\"ok\\")', 'process.stdout.write(\\"CEZAR_VERIFICATION_STATUS=no-tests\\")');
    await writeFile(config, value);
    const result = await executeVerification({ worktreePath: root, cezarRunId: 'run', projectId: 'project', suite: 'quick' });
    expect(result.run.status).toBe('no-tests');
    expect(result.run.semanticExitCode).toBe(2);
  });

  it('rejects an unknown suite before launching anything', async () => {
    const root = await fixture('invalid-suite');
    const result = await executeVerification({ worktreePath: root, cezarRunId: 'run', projectId: 'project', suite: 'absent' });
    expect(result.run.status).toBe('unknown');
    expect(result.run.checks[0]?.outputPreview).toContain('unknown verification suite');
    expect(JSON.parse(await readFile(result.artifactPath, 'utf8')).semanticExitCode).toBe(2);
  });

  it('records a non-green all-deferred outcome and a selection artifact when nothing is selected', async () => {
    const root = await fixture('not-selected');
    const result = await executeVerification({ worktreePath: root, cezarRunId: 'run', projectId: 'project', suite: 'quick', selection: { mode: 'last-failed', lastFailedCheckIds: [] } });
    expect(result.run.status).toBe('not-selected');
    expect(result.run.semanticExitCode).toBe(2);
    expect(result.run.coverage.selected).toBe(0);
    expect(result.run.checks[0]?.status).toBe('not-selected');
    expect(result.selection.checks[0]?.status).toBe('deferred');
    expect(result.run.artifacts[0]?.path).toContain('selection.json');
  });

  it('records malformed manifests as unknown result artifacts instead of hiding the failure', async () => {
    const root = await fixture('malformed');
    const config = join(root, '.ai/factory/factory.config.yaml');
    await writeFile(config, 'verification: [not valid');
    const result = await executeVerification({ worktreePath: root, cezarRunId: 'run', projectId: 'project', suite: 'quick' });
    expect(result.run.status).toBe('unknown');
    expect(result.run.checks[0]?.checkId).toBe('manifest');
    expect(result.run.semanticExitCode).toBe(2);
  });

  it('classifies a timeout as infrastructure failure and caps/truncates output as unknown', async () => {
    const root = await fixture('timeout');
    const config = join(root, '.ai/factory/factory.config.yaml');
    let value = await readFile(config, 'utf8');
    value = value.replace('process.stdout.write(\\"ok\\")', 'setTimeout(() => {}, 10000)').replace('timeoutSeconds: 5', 'timeoutSeconds: 1');
    await writeFile(config, value);
    const timedOut = await executeVerification({ worktreePath: root, cezarRunId: 'run', projectId: 'project', suite: 'quick' });
    expect(timedOut.run.status).toBe('infrastructure-error');
    expect(timedOut.run.semanticExitCode).toBe(3);

    value = value.replace(/^      args:.*$/m, `      args: ${JSON.stringify(['-e', 'process.stdout.write("x".repeat(30000))'])}`).replace('timeoutSeconds: 1', 'timeoutSeconds: 5');
    await writeFile(config, value);
    const overflow = await executeVerification({ worktreePath: root, cezarRunId: 'run', projectId: 'project', suite: 'quick' });
    expect(overflow.run.status).toBe('unknown');
    expect(overflow.run.checks[0]?.outputTruncated).toBe(true);
    expect(overflow.run.checks[0]?.outputPreview.length).toBeLessThanOrEqual(20_000);
  }, 15_000);

  it('classifies a missing executable as infrastructure failure', async () => {
    const root = await fixture('missing-executable');
    const config = join(root, '.ai/factory/factory.config.yaml');
    await writeFile(config, (await readFile(config, 'utf8')).replace(JSON.stringify(process.execPath), '"cezar-tool-that-does-not-exist"'));
    const result = await executeVerification({ worktreePath: root, cezarRunId: 'run', projectId: 'project', suite: 'quick' });
    expect(result.run.status).toBe('infrastructure-error');
    expect(result.run.semanticExitCode).toBe(3);
  });

  it('keeps required capability gaps unknown and permits optional gaps as explicit skips', async () => {
    const root = await fixture('capability');
    const config = join(root, '.ai/factory/factory.config.yaml');
    const value = (await readFile(config, 'utf8')).replace('optional: false', 'requires: [headless-engine]\n      optional: true');
    await writeFile(config, value);
    const optional = await executeVerification({ worktreePath: root, cezarRunId: 'run', projectId: 'project', suite: 'quick' });
    expect(optional.run.status).toBe('passed');
    expect(optional.run.coverage.skipped).toBe(1);
    const requiredValue = value.replace('optional: true', 'optional: false');
    await writeFile(config, requiredValue);
    const required = await executeVerification({ worktreePath: root, cezarRunId: 'run', projectId: 'project', suite: 'quick' });
    expect(required.run.status).toBe('unknown');
    expect(required.run.semanticExitCode).toBe(2);
  });

  it('runs optional discovery and the adapter preflight, execute, collect and cleanup hooks', async () => {
    const root = await fixture('adapter');
    const config = join(root, '.ai/factory/factory.config.yaml');
    await writeFile(config, (await readFile(config, 'utf8')).replace('optional: false', 'requires: [headless-engine]\n      optional: false'));
    const calls: string[] = [];
    const result = await executeVerification({
      worktreePath: root, cezarRunId: 'run', projectId: 'project', suite: 'quick',
      adapter: {
        discover: async () => { calls.push('discover'); return ['headless-engine']; },
        preflight: async () => { calls.push('preflight'); return {}; },
        execute: async (_context, runCommand) => { calls.push('execute'); return runCommand(); },
        collect: async (_context, check) => { calls.push('collect'); return check; },
        cleanup: async () => { calls.push('cleanup'); },
      },
    });
    expect(result.run.status).toBe('passed');
    expect(calls).toEqual(['discover', 'preflight', 'execute', 'collect', 'cleanup']);
  });

  it('serializes a declared resource across concurrent worktrees', async () => {
    const rootsForRun = await Promise.all([fixture('resource-a'), fixture('resource-b')]);
    for (const root of rootsForRun) {
      const config = join(root, '.ai/factory/factory.config.yaml');
      await writeFile(config, (await readFile(config, 'utf8')).replace('optional: false', 'resources: [exclusive-device]\n      optional: false'));
    }
    let active = 0;
    let peak = 0;
    const adapter: VerificationAdapter = {
      execute: async (_context, runCommand) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 100));
        try { return await runCommand(); } finally { active--; }
      },
    };
    await Promise.all(rootsForRun.map((worktreePath) => executeVerification({ worktreePath, cezarRunId: 'run', projectId: 'project', suite: 'quick', adapter })));
    expect(peak).toBe(1);
  });

  it('reports cancellation with its own semantic exit and excludes host secrets from child env', async () => {
    const root = await fixture('cancel');
    const config = join(root, '.ai/factory/factory.config.yaml');
    let value = await readFile(config, 'utf8');
    value = value.replace(/^      args:.*$/m, `      args: ${JSON.stringify(['-e', 'setTimeout(() => process.stdout.write(String(process.env.OPENAI_API_KEY || "missing")), 10000)'])}`).replace('timeoutSeconds: 5', 'timeoutSeconds: 10');
    await writeFile(config, value);
    const old = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-secret-value-long-enough';
    try {
      const started = Date.now();
      const result = await executeVerification({ worktreePath: root, cezarRunId: 'run', projectId: 'project', suite: 'quick', cancelled: () => Date.now() - started > 200 });
      expect(result.run.status, JSON.stringify(result.run.checks[0])).toBe('cancelled');
      expect(result.run.semanticExitCode).toBe(4);
      expect(result.output).not.toContain('test-secret-value-long-enough');
      value = value.replace(/^      args:.*$/m, `      args: ${JSON.stringify(['-e', 'process.stdout.write(String(process.env.OPENAI_API_KEY || "missing"))'])}`);
      await writeFile(config, value);
      const safeEnv = await executeVerification({ worktreePath: root, cezarRunId: 'run', projectId: 'project', suite: 'quick' });
      expect(safeEnv.output).toContain('missing');
      expect(safeEnv.output).not.toContain('test-secret-value-long-enough');
    } finally {
      if (old === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = old;
    }
  }, 15_000);
});
