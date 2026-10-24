import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VerificationIntegrityGuard } from './integrity.ts';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'verification-integrity-'));
  roots.push(root);
  const worktree = join(root, 'worktree');
  const dataDir = join(root, 'cezar-data');
  mkdirSync(join(worktree, '.ai/factory'), { recursive: true });
  mkdirSync(join(worktree, '.ai/cezar/workflows'), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(worktree, '.ai/factory/factory.config.yaml'), 'name: demo\nverification:\n  version: 1\n  checks: {}\n');
  writeFileSync(join(worktree, '.ai/cezar/workflows/verify.yaml'), 'name: verify\nsteps: []\n');
  writeFileSync(join(dataDir, 'verification-baseline.json'), '{"baseline":"approved"}');
  writeFileSync(join(dataDir, 'verification-findings.json'), '{"findings":[]}');
  return { worktree, dataDir };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('verification policy integrity guard', () => {
  it('ignores unrelated project config edits and detects verification manifest or workflow edits', () => {
    const { worktree, dataDir } = fixture();
    const guard = new VerificationIntegrityGuard(worktree, dataDir);
    writeFileSync(join(worktree, '.ai/factory/factory.config.yaml'), 'name: renamed\nverification:\n  checks: {}\n  version: 1\n');
    expect(guard.changes()).toEqual([]);
    writeFileSync(join(worktree, '.ai/factory/factory.config.yaml'), 'name: renamed\nverification:\n  version: 1\n  checks:\n    unit: changed\n');
    expect(guard.changes()).toContain('factory.config.yaml');
    writeFileSync(join(worktree, '.ai/factory/factory.config.yaml'), 'name: renamed\nverification:\n  checks: {}\n  version: 1\n');
    writeFileSync(join(worktree, '.ai/cezar/workflows/verify.yaml'), 'name: verify\nsteps: [weakened]\n');
    expect(guard.changes()).toContain('__workflow_catalog__');
  });

  it('detects baseline and historical ledger edits until only scheduler writes are refreshed', () => {
    const { worktree, dataDir } = fixture();
    const guard = new VerificationIntegrityGuard(worktree, dataDir);
    writeFileSync(join(dataDir, 'verification-baseline.json'), '{"baseline":"agent changed"}');
    writeFileSync(join(dataDir, 'verification-findings.json'), '{"findings":["deleted"]}');
    expect(guard.changes()).toEqual(expect.arrayContaining(['verification-baseline.json', 'verification-findings.json']));
    guard.refresh();
    expect(guard.changes()).toEqual([]);
  });
});
