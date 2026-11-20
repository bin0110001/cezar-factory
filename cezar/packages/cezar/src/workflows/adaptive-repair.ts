import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface AdaptiveCheckResult {
  checkId: string;
  status: 'passed' | 'failed' | 'inconclusive';
  message: string;
  output: string;
  commitSha: string;
}

export interface AdaptiveRepairDecision {
  schemaVersion: 1;
  action: 'repair' | 'replan' | 'done' | 'stop' | 'handoff' | 'retry' | 'backoff' | 'rerun-full-matrix' | 'none';
  reasonCode?: string;
  stopReason?: string;
  feedback?: Array<{ checkId: string; category?: string; disposition?: string; message: string; target?: string }>;
  summary?: { entries?: Array<{ findingId?: string; identifier?: string; message?: string }> };
}

const ACTIONS = new Set<AdaptiveRepairDecision['action']>([
  'repair', 'replan', 'done', 'stop', 'handoff', 'retry', 'backoff', 'rerun-full-matrix', 'none',
]);

export function parseAdaptiveRepairDecision(value: unknown): AdaptiveRepairDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('adaptive repair decision must be an object');
  const decision = value as Record<string, unknown>;
  if (decision.schemaVersion !== 1 || typeof decision.action !== 'string' || !ACTIONS.has(decision.action as AdaptiveRepairDecision['action'])) {
    throw new Error('adaptive repair decision has an unsupported schemaVersion or action');
  }
  if (decision.feedback !== undefined && (!Array.isArray(decision.feedback) || decision.feedback.some((item) => !item || typeof item !== 'object' || typeof (item as Record<string, unknown>).message !== 'string'))) {
    throw new Error('adaptive repair decision feedback is malformed');
  }
  return decision as unknown as AdaptiveRepairDecision;
}

export function adaptiveRepairFeedback(decision: AdaptiveRepairDecision): string {
  const entries = decision.feedback ?? [];
  const lines = entries.map((entry) => {
    const check = (typeof entry.checkId === 'string' ? entry.checkId : '').trim().slice(0, 128) || 'validation';
    const category = typeof entry.category === 'string' ? entry.category.trim().slice(0, 80) : undefined;
    const disposition = typeof entry.disposition === 'string' ? entry.disposition.trim().slice(0, 80) : undefined;
    const message = (typeof entry.message === 'string' ? entry.message : '').replace(/[\r\n]+/g, ' ').trim().slice(0, 400);
    return `- ${check}${category ? ` (${category})` : ''}${disposition ? `, ${disposition}` : ''}: ${message}`;
  });
  const findings = (decision.summary?.entries ?? []).map((entry) => {
    const rawId = typeof entry.findingId === 'string' ? entry.findingId : typeof entry.identifier === 'string' ? entry.identifier : 'finding';
    const id = rawId.trim().slice(0, 128);
    const message = (typeof entry.message === 'string' ? entry.message : '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
    return `- ${id}: ${message}`;
  });
  const body = [...lines, ...findings];
  if (!body.length) throw new Error('adaptive repair decision authorized repair without focused feedback');
  return [
    'The required validation matrix did not pass. Repair only the reported findings in this same task session.',
    'Keep the issue, branch, worktree, and session unchanged. Do not open or update a PR during repair.',
    ...body,
    'When the repair is complete, end the turn with CEZ:DONE. Do not claim success; validation will run again.',
  ].join('\n');
}

/** Digest the tracked diff plus non-ignored untracked files, so validation binds to the dirty artifact. */
export function worktreeArtifactRevision(cwd: string): string {
  const root = resolve(cwd);
  const hash = createHash('sha256');
  const diff = execFileSync('git', ['diff', '--binary', 'HEAD', '--'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  hash.update('tracked-diff\0');
  hash.update(diff);
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
  for (const name of untracked.toString('utf8').split('\0').filter(Boolean).sort()) {
    hash.update('\0untracked\0');
    hash.update(name);
    hash.update('\0');
    hash.update(readFileSync(resolve(root, name)));
  }
  return `sha256:${hash.digest('hex')}`;
}

