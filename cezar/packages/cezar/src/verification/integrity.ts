import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function snapshot(worktree: string, dataDir: string): Map<string, string> {
  const digests = new Map<string, string>();
  for (const path of [join(dataDir, 'verification-baseline.json'), join(dataDir, 'verification-findings.json')]) {
    try { digests.set(path, createHash('sha256').update(readFileSync(path)).digest('hex')); }
    catch (error) { digests.set(path, (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable'); }
  }
  const manifestPath = join(worktree, '.ai/factory/factory.config.yaml');
  try {
    const parsed = parseYaml(readFileSync(manifestPath, 'utf8')) as { verification?: unknown } | null;
    digests.set(manifestPath, createHash('sha256').update(stableJson(parsed?.verification ?? null)).digest('hex'));
  } catch (error) {
    digests.set(manifestPath, (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid');
  }
  const workflowsDir = join(worktree, '.ai/cezar/workflows');
  const catalogPath = join(workflowsDir, '__workflow_catalog__');
  try {
    const files = readdirSync(workflowsDir).filter((name) => ['.yaml', '.yml'].includes(name.slice(name.lastIndexOf('.')).toLowerCase())).sort();
    const catalog = files.map((name) => `${name}\0${readFileSync(join(workflowsDir, name))}`).join('\0');
    digests.set(catalogPath, createHash('sha256').update(catalog).digest('hex'));
  } catch (error) {
    digests.set(catalogPath, (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable');
  }
  return digests;
}

/** Detect changes to scheduler policy/history between agent turns; refresh only after scheduler writes. */
export class VerificationIntegrityGuard {
  private expected: Map<string, string>;
  constructor(private readonly worktree: string, private readonly dataDir: string) { this.expected = snapshot(worktree, dataDir); }
  changes(): string[] {
    const current = snapshot(this.worktree, this.dataDir);
    return [...this.expected.entries()].filter(([path, digest]) => current.get(path) !== digest).map(([path]) => path.split(/[\\/]/).pop() ?? path);
  }
  refresh(): void { this.expected = snapshot(this.worktree, this.dataDir); }
}
