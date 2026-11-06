import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { upsertBacklogMetadata } from './github-metadata.ts';
import { DEFAULT_FIELDS } from './model.ts';
import { backlogSyncEnabled, runBacklogSyncOnce } from './sync-timer.ts';
import type { GhRunner } from './github-sync.ts';

let home: string; let old: string | undefined;
beforeEach(() => { home = realpathSync.native(mkdtempSync(join(tmpdir(), 'cez-sync-timer-'))); old = process.env.CEZ_HOME; process.env.CEZ_HOME = home; });
afterEach(() => { if (old === undefined) delete process.env.CEZ_HOME; else process.env.CEZ_HOME = old; try { rmSync(home, { recursive: true, force: true }); } catch { /* the shared store keeps the sqlite file open on Windows */ } });

const body = upsertBacklogMetadata('text', { fields: { ...DEFAULT_FIELDS, basePriority: 'P2' }, version: 1, origin: 'bob', writeId: 'w1', updatedAt: 'x' });
const gh: GhRunner = async (args) => {
  if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([{ number: 1 }]);
  if (args[0] === 'api' && args[1]!.startsWith('repos/')) return JSON.stringify({ number: 1, body, state: 'open', labels: [] });
  throw new Error(`unexpected ${args.join(' ')}`);
};

describe('scheduled backlog sync', () => {
  it('needs both scheduling and the explicit sync opt-in', async () => {
    expect(backlogSyncEnabled({})).toBe(false);
    expect(backlogSyncEnabled({ CEZAR_BACKLOG_SCHEDULING: 'shadow' })).toBe(false);
    expect(backlogSyncEnabled({ CEZAR_BACKLOG_SYNC: 'on' })).toBe(false);
    expect(backlogSyncEnabled({ CEZAR_BACKLOG_SCHEDULING: 'shadow', CEZAR_BACKLOG_SYNC: 'on' })).toBe(true);
    expect(await runBacklogSyncOnce([{ root: '/x', github: { owner: 'o', repo: 'r' } }], { env: {} })).toBe('skipped');
  });
  it('syncs each GitHub project, skips others, isolates failures and logs counts', async () => {
    const logs: string[] = [];
    const env = { CEZAR_BACKLOG_SCHEDULING: 'shadow', CEZAR_BACKLOG_SYNC: 'on' } as NodeJS.ProcessEnv;
    const result = await runBacklogSyncOnce(
      [{ root: '/a', github: { owner: 'o', repo: 'r' } }, { root: '/b' }, { root: '/c', github: { owner: 'o', repo: 'broken' } }],
      { env, log: (m) => logs.push(m), gh: (root) => (root === '/c' ? async () => { throw new Error('boom'); } : gh) },
    );
    expect(result).not.toBe('skipped');
    const r = result as Record<string, Array<{ status: string }>>;
    expect(r['o/r']!.map((x) => x.status)).toEqual(['pulled']);
    expect(Object.keys(r)).toContain('o/r');
    expect(logs.some((l) => l.includes('o/r') && l.includes('pulled'))).toBe(true);
    expect(logs.some((l) => l.includes('o/broken') && l.includes('failed'))).toBe(true);
  });
});
