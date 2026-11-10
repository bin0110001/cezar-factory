import { describe, expect, it } from 'vitest';
import { resolveBashExecutable } from './command-shell.ts';

describe('Windows command shell selection', () => {
  it('uses the Git installation path before the WSL PATH shim', () => {
    const actual = 'C:\\Program Files\\Git\\mingw64\\libexec\\git-core';
    const selected = resolveBashExecutable({
      platform: 'win32', gitExecPath: actual, env: {},
      exists: (path) => path === 'C:\\Program Files\\Git\\bin\\bash.exe',
    });
    expect(selected).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
  });

  it('honors an existing explicit shell path and falls back when Git Bash is unavailable', () => {
    const override = 'D:\\tools\\bash.exe';
    expect(resolveBashExecutable({ platform: 'win32', env: { CEZAR_BASH_PATH: override }, exists: (path) => path === override })).toBe(override);
    expect(resolveBashExecutable({ platform: 'win32', env: {}, exists: () => false })).toBe('bash');
  });

  it('keeps the native bash command on Linux', () => {
    expect(resolveBashExecutable({ platform: 'linux', env: {}, exists: () => false })).toBe('bash');
  });
});
