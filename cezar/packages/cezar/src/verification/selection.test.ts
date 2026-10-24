import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verificationManifestSchema } from '@open-mercato/cezar-contract';
import { workflowStepSchema, stepKind } from '../workflows/types.ts';
import { collectVerificationDiff, selectVerificationChecks } from './selection.ts';

const roots: string[] = [];
function root(label: string) {
  const path = mkdtempSync(join(tmpdir(), `impact selection ${label} `));
  roots.push(path);
  return path;
}
const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

const manifest = verificationManifestSchema.parse({
  version: 1,
  checks: {
    room: { runner: 'command', executable: 'node', args: [], cwd: '.', timeoutSeconds: 10, owns: ['src/room_builder.gd'] },
    map: { runner: 'command', executable: 'node', args: [], cwd: '.', timeoutSeconds: 10, owns: ['Scenes/**/*.tscn'] },
    parse: { runner: 'command', executable: 'node', args: [], cwd: '.', timeoutSeconds: 10, owns: ['**/*.gd', '**/*.tscn', '**/*.tres'] },
    performance: { runner: 'command', executable: 'node', args: [], cwd: '.', timeoutSeconds: 10, owns: ['data/rooms/**'], tags: ['performance'], dependsOn: ['room'] },
    audio: { runner: 'command', executable: 'node', args: [], cwd: '.', timeoutSeconds: 10, owns: ['audio/**'] },
  },
  suites: { full: ['room', 'map', 'parse', 'performance', 'audio'] },
});

afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('verification change impact selection', () => {
  it('validates scheduler-owned selection modes on verification workflow steps', () => {
    const step = workflowStepSchema.parse({ id: 'verify-room', verificationSuite: 'full', verificationMode: 'component', verificationComponents: ['room'] });
    expect(stepKind(step)).toBe('check');
    expect(workflowStepSchema.parse({ id: 'verify-gated', verificationSuite: 'full', verificationGate: 'development' }).verificationGate).toBe('development');
    expect(workflowStepSchema.safeParse({ id: 'bad', verificationSuite: 'full', verificationMode: 'explicit' }).success).toBe(false);
    expect(workflowStepSchema.safeParse({ id: 'bad', verificationSuite: 'full', verificationMode: 'component' }).success).toBe(false);
    expect(workflowStepSchema.safeParse({ id: 'bad', command: 'true', verificationGate: 'release' }).success).toBe(false);
  });

  it('selects RoomBuilder, map, parse and related performance checks without unrelated audio', async () => {
    const repo = root('room');
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'Scenes'), { recursive: true });
    mkdirSync(join(repo, 'audio'), { recursive: true });
    writeFileSync(join(repo, 'src/room_builder.gd'), 'const ROOM = preload("res://Scenes/room.tscn")\n');
    writeFileSync(join(repo, 'Scenes/room.tscn'), '[gd_scene]\n');
    writeFileSync(join(repo, 'audio/audio_manager.gd'), 'func play(): pass\n');
    run(repo, 'init', '-q');
    run(repo, '-c', 'user.name=test', '-c', 'user.email=test@local', 'add', '.');
    run(repo, '-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'fixture');
    const result = await selectVerificationChecks(repo, manifest, 'full', { mode: 'impacted', changedPaths: ['Scenes/room.tscn', 'data/rooms/maps/room.json'] });
    expect(result.selectedIds).toEqual(expect.arrayContaining(['room', 'map', 'parse', 'performance']));
    expect(result.selectedIds).not.toContain('audio');
    expect(result.selection.checks.find((check) => check.checkId === 'audio')).toMatchObject({ status: 'deferred', reason: 'no direct or declared impact found' });
    expect(result.selection.checks.find((check) => check.checkId === 'room')?.reason).toContain('depends on changed Godot resource');
  });

  it('expands to the full suite when a changed script has dynamic resource loading', async () => {
    const repo = root('dynamic');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src/room_builder.gd'), 'var path = "res://Scenes/" + name\nvar scene = load(path)\n');
    run(repo, 'init', '-q');
    run(repo, '-c', 'user.name=test', '-c', 'user.email=test@local', 'add', '.');
    run(repo, '-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'fixture');
    const result = await selectVerificationChecks(repo, manifest, 'full', { mode: 'impacted', changedPaths: ['src/room_builder.gd'] });
    expect(result.selection.fallbackUsed).toBe(true);
    expect(result.selectedIds).toEqual(manifest.suites.full);
    expect(result.selection.checks.every((check) => check.confidence === 'low')).toBe(true);
  });

  it('supports explicit and last-failed selections without treating deferred checks as passed', async () => {
    const repo = root('modes');
    const explicit = await selectVerificationChecks(repo, manifest, 'full', { mode: 'explicit', checkIds: ['audio'] });
    expect(explicit.selectedIds).toEqual(['audio']);
    expect(explicit.selection.checks.filter((item) => item.status === 'deferred')).toHaveLength(4);
    const lastFailed = await selectVerificationChecks(repo, manifest, 'full', { mode: 'last-failed', lastFailedCheckIds: ['room', 'map'] });
    expect(lastFailed.selectedIds).toEqual(['room', 'map']);
    const none = await selectVerificationChecks(repo, manifest, 'full', { mode: 'last-failed', lastFailedCheckIds: [] });
    expect(none.selectedIds).toEqual([]);
    const component = await selectVerificationChecks(repo, manifest, 'full', { mode: 'component', componentTags: ['performance'] });
    expect(component.selectedIds).toEqual(['performance']);
    await expect(selectVerificationChecks(repo, manifest, 'full', { mode: 'component', componentTags: ['missing'] })).rejects.toThrow('no checks');
  });

  it('collects renamed paths and falls back to the full suite for an unknown base', async () => {
    const repo = root('rename');
    writeFileSync(join(repo, 'old.gd'), Array.from({ length: 20 }, (_, index) => `# preserved ${index}\nextends Node\n`).join(''));
    run(repo, 'init', '-q', '-b', 'base');
    run(repo, '-c', 'user.name=test', '-c', 'user.email=test@local', 'add', '.');
    run(repo, '-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'base');
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    run(repo, 'switch', '-qc', 'feature');
    rmSync(join(repo, 'old.gd'));
    writeFileSync(join(repo, 'renamed.gd'), `${Array.from({ length: 20 }, (_, index) => `# preserved ${index}\nextends Node\n`).join('')}# changed\n`);
    run(repo, '-c', 'user.name=test', '-c', 'user.email=test@local', 'add', '-A');
    run(repo, '-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'rename');
    const diff = await collectVerificationDiff(repo, 'base');
    expect(diff.uncertain).toBe(false);
    expect(diff.baseSha).toBe(base);
    expect(diff.renamedPaths).toContainEqual({ from: 'old.gd', to: 'renamed.gd' });
    const fallback = await selectVerificationChecks(repo, manifest, 'full', { mode: 'impacted', baseRef: 'missing-base' });
    expect(fallback.selection.fallbackUsed).toBe(true);
    expect(fallback.selectedIds).toEqual(manifest.suites.full);
  });
});
