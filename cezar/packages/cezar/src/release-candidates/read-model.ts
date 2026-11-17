import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TERMINAL_CANDIDATE_STATES, candidateSchema, releaseCandidatesResponseSchema, type Candidate, type ReleaseCandidatesResponse,
} from '@open-mercato/cezar-contract';
import { cezarHomeDir } from '../paths.ts';
import { collectSecretValues, redactDeep } from '../core/secret-redaction.ts';

/**
 * Release-candidate read model (#631). The host (the release engine) writes a snapshot; this validates it, redacts every string,
 * derives staleness, and enforces the one-active-candidate representation. It is read-only and never throws on a bad candidate:
 * a candidate that fails validation is dropped and reported as a warning, so one bad record cannot blank the whole view.
 */

export const CANDIDATES_SNAPSHOT_FILE = 'candidates.json';
const TERMINAL = new Set<string>(TERMINAL_CANDIDATE_STATES);
const KNOWN_KEYS = new Set(Object.keys(candidateSchema.shape));

export function snapshotPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(cezarHomeDir(env), 'release', CANDIDATES_SNAPSHOT_FILE);
}

export function readSnapshot(path: string): unknown {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined; } catch { return undefined; }
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

export function buildReleaseCandidates(snapshot: unknown, now: Date, extraSecrets: readonly string[] = []): ReleaseCandidatesResponse {
  const generatedAt = now.toISOString();
  const empty = (): ReleaseCandidatesResponse => ({ schemaVersion: 1, generatedAt, available: false, snapshotAt: null, projects: [] });
  const root = obj(snapshot);
  if (!snapshot || typeof root.projects !== 'object') return empty();

  const secrets = [...collectSecretValues(), ...extraSecrets];
  const snapshotAt = typeof root.snapshotAt === 'string' && !Number.isNaN(Date.parse(root.snapshotAt)) ? new Date(root.snapshotAt).toISOString() : null;
  const projects = Object.entries(obj(root.projects)).map(([projectId, raw]) => {
    const warnings: string[] = [];
    const candidates: Candidate[] = [];
    const list = Array.isArray(obj(raw).candidates) ? (obj(raw).candidates as unknown[]) : [];
    for (const item of list) {
      // Forward compatible: keep only the fields this contract knows, redact every string, then validate.
      const known = Object.fromEntries(Object.entries(obj(item)).filter(([k]) => KNOWN_KEYS.has(k)));
      const parsed = candidateSchema.safeParse(redactDeep({ ...known, projectId }, secrets));
      if (!parsed.success) { warnings.push(`a candidate record failed validation and was skipped (${String(obj(item).id ?? 'unknown id').slice(0, 64)})`); continue; }
      const c = parsed.data;
      const nonterminal = !TERMINAL.has(c.state);
      const leaseStale = nonterminal && c.lease.expiresAt !== null && Date.parse(c.lease.expiresAt) <= now.getTime();
      const extra = leaseStale && !c.warnings.some((w) => w.kind === 'stale-lease') ? [{ kind: 'stale-lease' as const, message: 'the lease has expired; the owner may have crashed' }] : [];
      candidates.push({ ...c, lease: { ...c.lease, stale: c.lease.stale || leaseStale }, warnings: [...c.warnings, ...extra] });
    }
    candidates.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
    const active = candidates.filter((c) => !TERMINAL.has(c.state));
    let current: Candidate | null = active[0] ?? null;
    if (active.length > 1) {
      // The release engine guarantees one; if a snapshot shows more, say so loudly instead of picking silently.
      warnings.push(`integrity: ${active.length} nonterminal candidates for one project (only one is allowed); showing the most recently updated`);
      if (current) current = { ...current, warnings: [...current.warnings, { kind: 'integrity', message: `${active.length} nonterminal candidates exist for this project` }] };
    }
    const history = candidates.filter((c) => c.id !== current?.id).slice(0, 50);
    return { projectId, active: current, history, warnings };
  }).sort((a, b) => a.projectId.localeCompare(b.projectId));

  return releaseCandidatesResponseSchema.parse({ schemaVersion: 1, generatedAt, available: true, snapshotAt, projects });
}
