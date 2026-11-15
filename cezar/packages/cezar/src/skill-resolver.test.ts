import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SkillResolutionError,
  bundleHash,
  cacheBundle,
  detectProjectType,
  materializeBundles,
  resolveSkills,
  selectSkills,
  type ProjectTypePolicy,
  type SkillBundle,
  type SkillCandidate,
} from './skill-resolver.ts';

const policies: ProjectTypePolicy[] = [
  { type: 'godot', detect: ['project.godot'], required: ['godot-gdscript'], optional: [{ name: 'godot-ui', tags: ['ui'] }] },
];

const b = (body: string): SkillBundle => ({ 'SKILL.md': body });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skill-resolver-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const catalog = (name: string, bundle: SkillBundle, extra: Partial<SkillCandidate> = {}): SkillCandidate => ({
  name,
  layer: 'catalog',
  origin: 'registry@abc',
  hash: bundleHash(bundle),
  required: true,
  ...extra,
});

describe('detectProjectType', () => {
  it('detects godot only when project.godot exists', () => {
    expect(detectProjectType(policies, (f) => f === 'project.godot')).toBe('godot');
    expect(detectProjectType(policies, () => false)).toBeNull();
  });
});

describe('selectSkills', () => {
  const cands = [catalog('godot-gdscript', b('g')), catalog('godot-ui', b('u'))];

  it('picks Godot skills for a Godot project and none otherwise', () => {
    const godot = selectSkills({ projectType: 'godot', policies, candidates: cands });
    expect(godot.chosen.map((c) => c.name)).toEqual(['godot-gdscript']);
    const other = selectSkills({ projectType: null, policies, candidates: cands });
    expect(other.chosen).toEqual([]);
  });

  it('selects optional skills by tag', () => {
    const r = selectSkills({ projectType: 'godot', policies, candidates: cands, taskTags: ['ui'] });
    expect(r.chosen.map((c) => c.name)).toEqual(['godot-gdscript', 'godot-ui']);
  });

  it('is independent of candidate order', () => {
    const a = selectSkills({ projectType: 'godot', policies, candidates: cands, taskTags: ['ui'] });
    const z = selectSkills({ projectType: 'godot', policies, candidates: [...cands].reverse(), taskTags: ['ui'] });
    expect(z).toEqual(a);
  });

  it('never lets the catalog shadow factory-* or a project override', () => {
    const r = selectSkills({
      projectType: 'godot',
      policies: [{ type: 'godot', detect: [], required: ['factory-implement', 'godot-gdscript'] }],
      candidates: [
        { name: 'factory-implement', layer: 'protected', origin: 'factory', bundle: b('real') },
        catalog('factory-implement', b('evil')),
        { name: 'godot-gdscript', layer: 'project', origin: '.ai/skills', bundle: b('mine') },
        catalog('godot-gdscript', b('registry')),
      ],
    });
    expect(r.chosen.map((c) => `${c.name}:${c.layer}`)).toEqual(['factory-implement:protected', 'godot-gdscript:project']);
    const denied = r.decisions.filter((d) => d.outcome === 'denied');
    expect(denied.map((d) => d.name).sort()).toEqual(['factory-implement', 'godot-gdscript']);
    expect(denied.every((d) => d.reason.length > 0)).toBe(true);
  });

  it('denies a skill whose requirements are unmet, with a reason', () => {
    const r = selectSkills({
      projectType: 'godot',
      policies,
      candidates: [catalog('godot-gdscript', b('g'), { requires: ['godot'] })],
    });
    expect(r.chosen).toEqual([]);
    expect(r.decisions[0]?.reason).toContain('godot');
  });
});

describe('resolveSkills pinning and cache', () => {
  const cacheRoot = () => join(dir, 'cache');
  const taskDir = () => join(dir, 'task');

  it('serves identical bytes on retry even when the catalog changes', async () => {
    const v1 = b('version one');
    const v2 = b('version two');
    const first = await resolveSkills({
      projectType: 'godot',
      policies,
      candidates: [catalog('godot-gdscript', v1)],
      cacheRoot: cacheRoot(),
      taskDir: taskDir(),
      fetchBundle: async () => v1,
    });
    expect(first.pinned).toBe(false);
    // Catalog now publishes v2; the retry must still get v1.
    await cacheBundle(cacheRoot(), v2);
    const retry = await resolveSkills({
      projectType: 'godot',
      policies,
      candidates: [catalog('godot-gdscript', v2)],
      cacheRoot: cacheRoot(),
      taskDir: taskDir(),
    });
    expect(retry.pinned).toBe(true);
    expect(retry.bundles.get('godot-gdscript')).toEqual(v1);
    expect(retry.manifest).toEqual(first.manifest);
  });

  it('resolves offline from the cache and fails clearly for an uncached required skill', async () => {
    const bundle = b('cached');
    await cacheBundle(cacheRoot(), bundle);
    const ok = await resolveSkills({
      projectType: 'godot',
      policies,
      candidates: [catalog('godot-gdscript', bundle)],
      cacheRoot: cacheRoot(),
      taskDir: join(dir, 't1'),
    });
    expect(ok.manifest.skills[0]?.hash).toBe(bundleHash(bundle));

    await expect(
      resolveSkills({
        projectType: 'godot',
        policies,
        candidates: [catalog('godot-gdscript', b('never cached'))],
        cacheRoot: cacheRoot(),
        taskDir: join(dir, 't2'),
      }),
    ).rejects.toThrow(/unavailable.*no cached bundle/);
  });

  it('denies (does not fail) an uncached optional skill', async () => {
    const r = await resolveSkills({
      projectType: 'godot',
      policies: [{ type: 'godot', detect: [], required: ['godot-ui'] }],
      candidates: [catalog('godot-ui', b('x'), { required: false })],
      cacheRoot: cacheRoot(),
      taskDir: taskDir(),
    });
    expect(r.manifest.skills).toEqual([]);
    expect(r.manifest.decisions[0]?.outcome).toBe('denied');
  });

  it('rejects a fetched bundle whose hash does not match the pin', async () => {
    await expect(
      resolveSkills({
        projectType: 'godot',
        policies,
        candidates: [catalog('godot-gdscript', b('expected'))],
        cacheRoot: cacheRoot(),
        taskDir: taskDir(),
        fetchBundle: async () => b('tampered'),
      }),
    ).rejects.toMatchObject({ code: 'integrity' });
  });

  it('detects a tampered cache entry', async () => {
    const bundle = b('good');
    const hash = await cacheBundle(cacheRoot(), bundle);
    await writeFile(join(cacheRoot(), hash, 'SKILL.md'), 'bad', 'utf8');
    await expect(
      resolveSkills({
        projectType: 'godot',
        policies,
        candidates: [catalog('godot-gdscript', bundle)],
        cacheRoot: cacheRoot(),
        taskDir: taskDir(),
      }),
    ).rejects.toBeInstanceOf(SkillResolutionError);
  });
});

describe('materializeBundles / paths', () => {
  it('writes into .claude/skills/<name> in the worktree', async () => {
    await materializeBundles(dir, new Map([['godot-gdscript', { 'SKILL.md': 'hi', 'scripts/run.sh': 'echo' }]]));
    expect(await readFile(join(dir, '.claude/skills/godot-gdscript/scripts/run.sh'), 'utf8')).toBe('echo');
  });

  it('rejects traversal and absolute paths in a bundle', async () => {
    for (const bad of ['../evil', '/etc/passwd', 'a/../../b', 'a\\b']) {
      await expect(materializeBundles(dir, new Map([['s', { [bad]: 'x' }]]))).rejects.toMatchObject({
        code: 'unsafe-path',
      });
    }
    await expect(materializeBundles(dir, new Map([['../s', b('x')]]))).rejects.toMatchObject({ code: 'unsafe-path' });
  });
});
