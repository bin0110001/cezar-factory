import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverSkills } from '../skills.ts';
import { loadWorkflows } from '../workflows/load.ts';

let roots: string[] = [];
const saved = { workflows: process.env.CEZ_SHARED_WORKFLOWS_DIRS, skills: process.env.CEZ_SHARED_SKILL_DIRS };
async function tempDir() { const path = await mkdtemp(join(tmpdir(), 'factory-catalog-pin-')); roots.push(path); return path; }
afterEach(async () => {
  if (saved.workflows === undefined) delete process.env.CEZ_SHARED_WORKFLOWS_DIRS; else process.env.CEZ_SHARED_WORKFLOWS_DIRS = saved.workflows;
  if (saved.skills === undefined) delete process.env.CEZ_SHARED_SKILL_DIRS; else process.env.CEZ_SHARED_SKILL_DIRS = saved.skills;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const pin = { projectId: 'shop', channel: 'dev' as const, sourceSha: '0123456789abcdef0123456789abcdef01234567', manifestDigest: `sha256:${'a'.repeat(64)}`, releaseRoot: '', runtimeRoot: '', resolvedAt: '2026-10-23T12:00:00Z' };
const workflow = (name: string, command: string) => `name: ${name}\nsteps:\n  - id: check\n    command: ${command}\n`;
const skill = (body: string) => `---\nname: shared-guide\n---\n${body}\n`;

describe('Factory catalog pinning', () => {
  it('loads shared workflows from the selected immutable SHA and keeps project overrides first', async () => {
    const repo = await tempDir();
    const release = await tempDir();
    const mutable = await tempDir();
    await mkdir(join(repo, '.ai/cezar/workflows'), { recursive: true });
    await mkdir(join(release, 'workflows'), { recursive: true });
    await mkdir(join(mutable, 'workflows'), { recursive: true });
    await writeFile(join(repo, '.ai/cezar/workflows/override.yaml'), workflow('factory-override', 'echo local'));
    await writeFile(join(release, 'workflows/override.yaml'), workflow('factory-override', 'echo pinned'));
    await writeFile(join(release, 'workflows/pinned.yaml'), workflow('factory-pinned', 'echo pinned'));
    await writeFile(join(mutable, 'workflows/mutable.yaml'), workflow('factory-mutable', 'echo mutable'));
    process.env.CEZ_SHARED_WORKFLOWS_DIRS = join(mutable, 'workflows');
    const result = await loadWorkflows(repo, { factoryRelease: { ...pin, releaseRoot: release, runtimeRoot: release } });
    expect(result.workflows.find((entry) => entry.name === 'factory-override')?.steps[0]?.command).toBe('echo local');
    expect(result.workflows.find((entry) => entry.name === 'factory-pinned')?.path).toBe(join(release, 'workflows/pinned.yaml'));
    expect(result.workflows.some((entry) => entry.name === 'factory-mutable')).toBe(false);
    expect(result.workflows.find((entry) => entry.name === 'factory-pinned')?.factoryRelease?.sourceSha).toBe(pin.sourceSha);
  });

  it('loads Factory skills from the pinned release instead of the mutable shared mount', async () => {
    const repo = await tempDir();
    const release = await tempDir();
    const mutable = await tempDir();
    await mkdir(join(release, 'skills/shared-guide'), { recursive: true });
    await mkdir(join(mutable, 'shared-guide'), { recursive: true });
    await writeFile(join(release, 'skills/shared-guide/SKILL.md'), skill('from pinned'));
    await writeFile(join(mutable, 'shared-guide/SKILL.md'), skill('from mutable'));
    process.env.CEZ_SHARED_SKILL_DIRS = mutable;
    const found = await discoverSkills(repo, { factoryReleaseRoot: release });
    expect(found.find((entry) => entry.name === 'shared-guide')?.body).toContain('from pinned');
    expect(found.find((entry) => entry.name === 'shared-guide')?.body).not.toContain('from mutable');
  });
});
