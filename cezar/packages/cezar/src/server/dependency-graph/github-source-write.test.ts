import { describe, expect, it, vi } from 'vitest';
import { GithubDependencySource } from './github-source.ts';

describe('GitHub dependency writes', () => {
  it('adds and verifies a same-repository blocker using the GitHub REST API', async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce('[]')
      .mockResolvedValueOnce('12345')
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce('[{"number":4},{"number":9}]');
    const source = new GithubDependencySource('C:/repo', runner, async () => 'https://github.com/acme/work.git');
    expect(await source.setBlocker(9, 4, 'add')).toEqual({ changed: true });
    expect(runner.mock.calls[2]?.[1]).toEqual(['api', '--hostname', 'github.com', '--method', 'POST', '--field', 'issue_id=12345', 'repos/acme/work/issues/9/dependencies/blocked_by']);
  });

  it('removes a blocker by database id and verifies its absence', async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce('[{"number":4}]')
      .mockResolvedValueOnce('12345')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('[]');
    const source = new GithubDependencySource('C:/repo', runner, async () => 'https://github.com/acme/work.git');
    expect(await source.setBlocker(9, 4, 'remove')).toEqual({ changed: true });
    expect(runner.mock.calls[2]?.[1]).toEqual(['api', '--hostname', 'github.com', '--method', 'DELETE', 'repos/acme/work/issues/9/dependencies/blocked_by/12345']);
  });

  it('does not issue a write when the requested relation is already in the target state', async () => {
    const runner = vi.fn().mockResolvedValueOnce('[{"number":4}]');
    const source = new GithubDependencySource('C:/repo', runner, async () => 'https://github.com/acme/work.git');
    expect(await source.setBlocker(9, 4, 'add')).toEqual({ changed: false });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('fails if GitHub does not reflect the requested mutation', async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce('[]')
      .mockResolvedValueOnce('12345')
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce('[]');
    const source = new GithubDependencySource('C:/repo', runner, async () => 'https://github.com/acme/work.git');
    await expect(source.setBlocker(9, 4, 'add')).rejects.toThrow(/could not be verified/);
  });
});
