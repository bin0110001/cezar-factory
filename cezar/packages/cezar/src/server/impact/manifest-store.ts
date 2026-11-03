import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cezarHomeDir } from '../../paths.ts';
import { parseManifest, type ImpactManifest } from './manifest.ts';

/**
 * File-backed manifest artifacts (#195): one JSON file per issue under the Cezar home, written
 * atomically, schema-validated on both write and read, and strictly revision-monotonic so a late
 * or replayed planner run cannot overwrite a newer manifest. Sensitive path handling stays in
 * manifest.ts (`redactForScheduler`); this store is host-local and is never shipped to GitHub.
 */
export type SaveResult = { saved: true; replaced: boolean } | { saved: false; reason: 'stale-revision' | 'invalid'; errors?: string[] };

export class ManifestStore {
  private readonly dir: string;
  constructor(options: { home?: string } = {}) {
    this.dir = resolve(options.home ?? cezarHomeDir(), 'impact-manifests');
  }

  private fileFor(repository: string, issue: number): string {
    const repoKey = createHash('sha256').update(repository.toLowerCase()).digest('hex').slice(0, 16);
    return join(this.dir, repoKey, `issue-${issue}.json`);
  }

  save(input: unknown): SaveResult {
    const parsed = parseManifest(input);
    if (!parsed.ok) return { saved: false, reason: 'invalid', errors: parsed.errors };
    const m = parsed.manifest;
    const file = this.fileFor(m.issue.repository, m.issue.number);
    const existing = this.read(file);
    if (existing && existing.manifestRevision >= m.manifestRevision) return { saved: false, reason: 'stale-revision' };
    mkdirSync(resolve(file, '..'), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 });
    renameSync(tmp, file);
    return { saved: true, replaced: existing !== null };
  }

  private read(file: string): ImpactManifest | null {
    if (!existsSync(file)) return null;
    try {
      const parsed = parseManifest(JSON.parse(readFileSync(file, 'utf8')));
      return parsed.ok ? parsed.manifest : null; // a corrupt or newer-schema file reads as "no manifest", i.e. unknown coverage
    } catch { return null; }
  }

  get(repository: string, issue: number): ImpactManifest | null {
    return this.read(this.fileFor(repository, issue));
  }

  list(repository: string): ImpactManifest[] {
    const repoDir = join(this.dir, createHash('sha256').update(repository.toLowerCase()).digest('hex').slice(0, 16));
    if (!existsSync(repoDir)) return [];
    return readdirSync(repoDir).filter((f) => f.endsWith('.json')).map((f) => this.read(join(repoDir, f))).filter((m): m is ImpactManifest => m !== null)
      .sort((a, b) => a.issue.number - b.issue.number);
  }
}
