import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  candidateActionScopes,
  destructiveCandidateActions,
  type CandidateAction,
  type CandidateActionRequest,
  type CandidateActionResponse,
  type CandidateAuditEntry,
} from '@open-mercato/cezar-contract';

/** Active candidate as the lifecycle state machine (#590) reports it. */
export interface CandidateView { id: string; state: string }

/**
 * Port to the candidate lifecycle state machine (#590). The endpoint never mutates candidate
 * state itself: every transition is delegated here. #590 is not merged yet, so the default port
 * (`unavailableLifecycle`) refuses every action; wire the real state machine in by implementing it.
 */
export interface CandidateLifecyclePort {
  activeCandidate(projectId: string): Promise<CandidateView | null>;
  /** Delegates the transition. Throws `LifecycleRejection` when the state machine refuses it. */
  apply(projectId: string, action: CandidateAction, args: { candidateId?: string; sourceSha?: string }): Promise<CandidateView>;
}
export class LifecycleRejection extends Error {}
export const unavailableLifecycle: CandidateLifecyclePort = {
  activeCandidate: async () => null,
  apply: async () => { throw new LifecycleRejection('The candidate lifecycle state machine is not available yet'); },
};

let installedLifecycle: CandidateLifecyclePort = unavailableLifecycle;
/** Install the #590 state machine adapter (or a test double). */
export function setCandidateLifecycle(port: CandidateLifecyclePort): void { installedLifecycle = port; }
export function candidateLifecycle(): CandidateLifecyclePort { return installedLifecycle; }

export interface CandidateAuditSink { write(entry: CandidateAuditEntry): Promise<void> }
export function jsonlAuditSink(path: string): CandidateAuditSink {
  return { write: async (entry) => { await mkdir(dirname(path), { recursive: true }); await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8'); } };
}

/** Scopes granted to this server, from `CEZ_OPERATOR_SCOPES` (comma list or `*`). Deny by default. */
export function grantedScopes(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.CEZ_OPERATOR_SCOPES ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}
function allowed(granted: Set<string>, action: CandidateAction): boolean {
  return granted.has('*') || granted.has('candidate:*') || granted.has(candidateActionScopes[action]);
}

export interface CandidateActionResult { status: 200 | 400 | 403 | 409 | 502; body: CandidateActionResponse }

export async function runCandidateAction(
  req: CandidateActionRequest,
  deps: { lifecycle: CandidateLifecyclePort; audit: CandidateAuditSink; scopes: Set<string>; actor: string; now?: () => Date },
): Promise<CandidateActionResult> {
  const finish = async (status: CandidateActionResult['status'], outcome: CandidateActionResponse['outcome'], message: string, candidate: CandidateView | null, candidateId = candidate?.id ?? req.candidateId ?? null) => {
    // The audit entry holds identifiers only; never request payload beyond these fields.
    await deps.audit.write({ at: (deps.now?.() ?? new Date()).toISOString(), actor: deps.actor, projectId: req.projectId, candidateId, action: req.action, outcome });
    return { status, body: { schemaVersion: 1 as const, outcome, message, candidateId, state: candidate?.state ?? null } };
  };

  if (!allowed(deps.scopes, req.action)) return finish(403, 'denied', `Missing scope ${candidateActionScopes[req.action]}`, null);

  if (req.action === 'create') {
    if (!req.sourceSha) return finish(400, 'rejected', 'create requires sourceSha', null);
    const active = await deps.lifecycle.activeCandidate(req.projectId);
    if (active) return finish(409, 'rejected', `Project ${req.projectId} already has an active candidate (${active.id}, ${active.state}); finish, cancel or abandon it first`, active);
  } else {
    if (!req.candidateId) return finish(400, 'rejected', `${req.action} requires candidateId`, null);
    if ((destructiveCandidateActions as readonly string[]).includes(req.action) && req.confirmation !== `${req.action} ${req.candidateId}`) {
      return finish(409, 'confirmation_required', `Type "${req.action} ${req.candidateId}" to confirm`, null);
    }
  }

  try {
    const next = await deps.lifecycle.apply(req.projectId, req.action, { candidateId: req.candidateId, sourceSha: req.sourceSha });
    return finish(200, 'accepted', `${req.action} applied`, next);
  } catch (error) {
    if (error instanceof LifecycleRejection) return finish(409, 'rejected', error.message, null);
    return finish(502, 'failed', 'The lifecycle state machine failed to apply the action', null);
  }
}
