import { describe, expect, it } from 'vitest';
import { resolveWorkflowCheckShell } from './check-shell.ts';

describe('resolveWorkflowCheckShell', () => {
  it('uses an explicitly configured shell', () => {
    expect(resolveWorkflowCheckShell('win32', { CEZ_CHECK_SHELL: 'C:\\tools\\bash.exe' }, () => false))
      .toBe('C:\\tools\\bash.exe');
  });

  it('prefers Git Bash over the Windows WSL bash alias', () => {
    const expected = 'C:\\Program Files\\Git\\bin\\bash.exe';
    expect(resolveWorkflowCheckShell('win32', { ProgramFiles: 'C:\\Program Files' }, (path) => path === expected))
      .toBe(expected);
  });

  it('uses bash on non-Windows runtimes', () => {
    expect(resolveWorkflowCheckShell('linux', { ProgramFiles: 'C:\\Program Files' }, () => false)).toBe('bash');
  });

  it('falls back to PATH when no standard Git Bash installation exists', () => {
    expect(resolveWorkflowCheckShell('win32', {}, () => false)).toBe('bash');
  });
});
