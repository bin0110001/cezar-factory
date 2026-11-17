import { appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  DESTRUCTIVE_CANDIDATE_ACTIONS, type CandidateActionRequest, type CandidateActionResponse, type ReleaseCandidatesResponse,
} from '@open-mercato/cezar-contract';
import { cezarHomeDir } from '../paths.ts';
import { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';

/**
 * Operator actions on release candidates (#634). The service does not mutate candidate state: it checks the request against the
 * published snapshot and records an audited request for the host release engine, which applies it through the lifecycle state
 * machine. Checks, in order: permission (local machine only), the project exists, the one-active-candidate rule for `create`, the
 * candidate the action names, a state the action is valid in, and typed confirmation for destructive actions.
 */

export const ACTIONS_FILE = 'actions.jsonl';
const TERMINAL = new Set(['promoted', 'abandoned', 'failed', 'canceled']);
const DESTRUCTIVE = new Set<string>(DESTRUCTIVE_CANDIDATE_ACTIONS);

export function actionsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(cezarHomeDir(env), 'release', ACTIONS_FILE);
}

export type ActionDecision = { ok: true; candidateId: string | null; message: string } | { ok: false; status: 400 | 403 | 404 | 409; error: string };

const deny = (status: 400 | 403 | 404 | 409, error: string): ActionDecision => ({ ok: false, status, error });

export function evaluateAction(snapshot: ReleaseCandidatesResponse, req: CandidateActionRequest, ctx: { localHandoff: boolean }): ActionDecision {
  if (!ctx.localHandoff) return deny(403, 'Release candidate actions are only available from the local machine, not a remote cockpit.');
  if (!snapshot.available) return deny(409, 'The release engine has not published a candidate snapshot, so no action can be validated.');
  const project = snapshot.projects.find((p) => p.projectId === req.projectId);
  if (!project) return deny(404, `Project ${req.projectId} has no release candidates.`);
  const active = project.active;

  if (req.action === 'create') {
    if (active) return deny(409, `Project ${req.projectId} already has an active candidate (${active.id}, ${active.state}). Only one candidate can be active; cancel or abandon it first.`);
    return { ok: true, candidateId: null, message: 'Candidate creation requested.' };
  }

  if (req.action === 'retry' && !active) {
    // A failed candidate is retried by starting a new one from the same trigger; there must be nothing active.
    const last = project.history[0];
    if (last?.state === 'failed') return { ok: true, candidateId: last.id, message: 'Retry of the last failed candidate requested.' };
    return deny(409, 'There is no active or failed candidate to retry.');
  }

  if (!req.candidateId) return deny(400, `${req.action} needs a candidateId.`);
  if (!active || active.id !== req.candidateId) {
    return deny(409, active ? `${req.candidateId} is not the active candidate; the active one is ${active.id}.` : `${req.candidateId} is not active; terminal candidates cannot be changed.`);
  }
  if (TERMINAL.has(active.state)) return deny(409, `${active.id} is already ${active.state}.`);
  if (req.action === 'retry' && active.state !== 'repair-required') return deny(409, `Only a candidate that needs repair can be retried; ${active.id} is ${active.state}.`);
  if (DESTRUCTIVE.has(req.action) && req.confirm !== active.id) {
    return deny(400, `${req.action} is destructive: type the candidate id (${active.id}) to confirm.`);
  }
  return { ok: true, candidateId: active.id, message: `${req.action} requested for ${active.id}.` };
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: CandidateActionRequest['action'];
  projectId: string;
  candidateId: string | null;
  reason: string;
  snapshotAt: string | null;
  confirmed: boolean;
}

/** Append the request to the host-owned queue. This file is the audit trail and the engine's inbox; a write failure rejects the action. */
export function recordAction(req: CandidateActionRequest, decision: Extract<ActionDecision, { ok: true }>, snapshot: ReleaseCandidatesResponse, now: Date, path = actionsPath()): CandidateActionResponse {
  const secrets = collectSecretValues();
  const entry: AuditEntry = {
    id: `act-${randomUUID().slice(0, 12)}`, at: now.toISOString(), actor: 'local-operator', action: req.action, projectId: req.projectId,
    candidateId: decision.candidateId, reason: redactSecrets(req.reason, secrets), snapshotAt: snapshot.snapshotAt, confirmed: DESTRUCTIVE.has(req.action),
  };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { accepted: true, requestId: entry.id, action: req.action, projectId: req.projectId, candidateId: decision.candidateId, status: 'queued', message: decision.message };
}
