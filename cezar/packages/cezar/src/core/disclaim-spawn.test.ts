import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DISCLAIM_EXEC_FLAG, disclaimedCommand, nodeScriptCommand } from './disclaim-spawn.ts';

const dir = mkdtempSync(join(tmpdir(), 'cez-disclaim-'));
const exe = (name: string) => {
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\n');
  chmodSync(path, 0o755);
  return path;
};
const trampoline = exe('Cezar');
const claude = exe('claude');
const script = join(dir, 'mock-agent.mjs');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const darwin = { platform: 'darwin' as const, hostEnv: { CEZ_DISCLAIM_EXEC: trampoline } };

describe('disclaimedCommand', () => {
  it('runs JavaScript command shims with the current Node executable', () => {
    expect(nodeScriptCommand(script, ['--acp'])).toEqual([process.execPath, [script, '--acp']]);
    expect(nodeScriptCommand('claude', ['-p'])).toEqual(['claude', ['-p']]);
    expect(disclaimedCommand(script, ['--acp'], {}, { platform: 'linux' }))
      .toEqual([process.execPath, [script, '--acp']]);
  });

  it.skipIf(process.platform === 'win32')('routes an agent through the desktop trampoline, resolved on the child PATH', () => {
    expect(disclaimedCommand('claude', ['-p', 'x'], { PATH: `/nowhere${delimiter}${dir}` }, darwin))
      .toEqual([trampoline, [DISCLAIM_EXEC_FLAG, claude, '-p', 'x']]);
    expect(disclaimedCommand(claude, [], {}, darwin)).toEqual([trampoline, [DISCLAIM_EXEC_FLAG, claude]]);
    expect(disclaimedCommand(script, ['--acp'], {}, darwin))
      .toEqual([trampoline, [DISCLAIM_EXEC_FLAG, process.execPath, script, '--acp']]);
  });

  it('leaves the command alone outside the desktop app and off macOS', () => {
    expect(disclaimedCommand('claude', ['-p'], { PATH: dir }, { platform: 'darwin', hostEnv: {} })).toEqual(['claude', ['-p']]);
    expect(disclaimedCommand('claude', ['-p'], { PATH: dir }, { ...darwin, platform: 'linux' })).toEqual(['claude', ['-p']]);
    expect(disclaimedCommand('claude', [], { PATH: dir }, { platform: 'darwin', hostEnv: { CEZ_DISCLAIM_EXEC: join(dir, 'gone') } }))
      .toEqual(['claude', []]);
  });

  it('keeps a missing program a plain spawn, so ENOENT and its install hint survive', () => {
    expect(disclaimedCommand('codex', ['app-server'], { PATH: dir }, darwin)).toEqual(['codex', ['app-server']]);
    expect(disclaimedCommand('./claude', [], { PATH: dir }, darwin)).toEqual(['./claude', []]);
  });
});
