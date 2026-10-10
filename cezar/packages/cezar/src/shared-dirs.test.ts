import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverSkills } from './skills.ts';
import { sharedDirs } from './shared-dirs.ts';
import { loadWorkflows } from './workflows/load.ts';

const tempDirs: string[] = [];
const saved = { wf: process.env.CEZ_SHARED_WORKFLOWS_DIRS, sk: process.env.CEZ_SHARED_SKILL_DIRS };

afterEach(async () => {
  if (saved.wf === undefined) delete process.env.CEZ_SHARED_WORKFLOWS_DIRS;
  else process.env.CEZ_SHARED_WORKFLOWS_DIRS = saved.wf;
  if (saved.sk === undefined) delete process.env.CEZ_SHARED_SKILL_DIRS;
  else process.env.CEZ_SHARED_SKILL_DIRS = saved.sk;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-shared-'));
  tempDirs.push(dir);
  return dir;
}

const workflow = (name: string, command: string) =>
  `name: ${name}\ndescription: test\nsteps:\n  - id: only\n    name: Only\n    command: ${command}\n`;

describe('sharedDirs', () => {
  it('splits on the platform delimiter, drops blanks, and resolves paths', () => {
    const env = { X: ['a', '', ' b '].join(delimiter) } as NodeJS.ProcessEnv;
    expect(sharedDirs('X', env)).toEqual([resolve('a'), resolve('b')]);
    expect(sharedDirs('MISSING', env)).toEqual([]);
  });
});

describe('shared workflow and skill catalogs', () => {
  it('loads shared workflows, and a repo workflow of the same name wins', async () => {
    const repo = await temp();
    const shared = await temp();
    await mkdir(join(repo, '.ai/cezar/workflows'), { recursive: true });
    await writeFile(join(repo, '.ai/cezar/workflows/override.yaml'), workflow('factory-x', 'echo local'));
    await writeFile(join(shared, 'x.yaml'), workflow('factory-x', 'echo shared'));
    await writeFile(join(shared, 'y.yaml'), workflow('factory-y', 'echo shared'));
    process.env.CEZ_SHARED_WORKFLOWS_DIRS = shared;

    const { workflows } = await loadWorkflows(repo);
    const x = workflows.find((w) => w.name === 'factory-x');
    expect(x?.path).toBe(join(repo, '.ai/cezar/workflows/override.yaml'));
    expect(workflows.find((w) => w.name === 'factory-y')?.path).toBe(join(shared, 'y.yaml'));
  });

  it('adds no shared workflows when the variable is unset', async () => {
    const repo = await temp();
    delete process.env.CEZ_SHARED_WORKFLOWS_DIRS;
    const { workflows } = await loadWorkflows(repo);
    expect(workflows.map((w) => w.name)).toEqual(['quick-task']);
  });

  it('discovers shared skills below the project-local ones', async () => {
    const repo = await temp();
    const shared = await temp();
    await mkdir(join(repo, '.ai/skills/factory-a'), { recursive: true });
    await mkdir(join(shared, 'factory-a'), { recursive: true });
    await mkdir(join(shared, 'factory-b'), { recursive: true });
    await writeFile(join(repo, '.ai/skills/factory-a/SKILL.md'), 'local a');
    await writeFile(join(shared, 'factory-a/SKILL.md'), 'shared a');
    await writeFile(join(shared, 'factory-b/SKILL.md'), 'shared b');
    process.env.CEZ_SHARED_SKILL_DIRS = shared;

    const skills = await discoverSkills(repo);
    expect(skills.find((s) => s.name === 'factory-a')?.body).toBe('local a');
    expect(skills.find((s) => s.name === 'factory-b')?.body).toBe('shared b');
  });
});
