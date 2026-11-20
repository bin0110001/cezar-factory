import type { AgentBackend, AgentRunner, AgentSession } from './agent-runner.ts';

/** Provider capability for continuing an existing coding-agent conversation. */
export interface SessionContinuationCapability {
  /** A message can be delivered to the already-running provider process. */
  live: boolean;
  /** Whether a closed process can reopen its provider-owned conversation. */
  processResume: 'native' | 'runtime' | 'unsupported';
  /** Why a required continuation cannot be performed. */
  reason?: string;
}

/**
 * Current adapter guarantees. `runtime` means the adapter must confirm the
 * provider advertised support before attempting a resume; it must not silently
 * create a replacement conversation.
 */
export const SESSION_CONTINUATION_CAPABILITIES: Readonly<Record<AgentBackend, SessionContinuationCapability>> = {
  claude: { live: true, processResume: 'native' },
  'claude-cli': { live: true, processResume: 'native' },
  codex: { live: true, processResume: 'native' },
  opencode: { live: true, processResume: 'unsupported', reason: 'the runner creates a new server-side session' },
  cursor: { live: false, processResume: 'unsupported', reason: 'print mode exits after its first result' },
  pi: { live: true, processResume: 'native' },
  junie: { live: true, processResume: 'native' },
  copilot: { live: true, processResume: 'runtime', reason: 'resume requires advertised ACP session/load support' },
};

/** Stable ownership facts for a live conversation. Prompt text is never part of this reference. */
export interface AgentSessionRef {
  runId: string;
  stepId: string;
  sessionId: string;
  backend: AgentBackend;
  origin: 'started' | 'resumed';
  worktree: string;
  profileId?: string;
  modelIdentity?: string;
  issueNumber?: number;
}

export type SessionContinuationResult =
  | { status: 'sent'; round: number }
  | { status: 'duplicate'; round: number }
  | { status: 'busy'; activeKey: string }
  | { status: 'session_unavailable'; reason: string }
  | { status: 'unsupported'; reason: string };

export interface SessionContinuationMetrics {
  sessionStarts: number;
  sessionResumptions: number;
  continuationTurns: number;
  duplicateRequests: number;
}

/**
 * Owns the in-memory continuation lease for one existing provider session.
 * The controller never starts a runner, creates a worktree, or retains repair
 * prompt text. `completeTurn` is called by the coordinator when that message's
 * provider turn ends; until then, a second distinct continuation is rejected.
 * Durable idempotency across process crashes belongs to the existing run
 * lifecycle/receipt layer, not this in-memory adapter seam.
 */
export class AgentSessionContinuation {
  readonly ref: Readonly<AgentSessionRef>;
  private readonly acceptedKeys = new Map<string, number>();
  private pendingKey: string | undefined;
  private continuationTurns = 0;
  private duplicateRequests = 0;

  constructor(
    ref: AgentSessionRef,
    private readonly session: Pick<AgentSession, 'open' | 'sendMessage'>,
    private readonly capability: SessionContinuationCapability,
  ) {
    if (!ref.runId.trim() || !ref.stepId.trim() || !ref.sessionId.trim() || !ref.worktree.trim()) {
      throw new TypeError('session reference requires runId, stepId, sessionId, and worktree');
    }
    this.ref = Object.freeze({ ...ref });
  }

  continueSession(feedback: string, idempotencyKey: string): SessionContinuationResult {
    if (!feedback.trim()) throw new TypeError('continuation feedback must not be blank');
    if (!idempotencyKey.trim()) throw new TypeError('continuation idempotencyKey must not be blank');

    const acceptedRound = this.acceptedKeys.get(idempotencyKey);
    if (acceptedRound !== undefined) {
      this.duplicateRequests++;
      return { status: 'duplicate', round: acceptedRound };
    }
    if (!this.capability.live) {
      return {
        status: 'unsupported',
        reason: this.capability.reason ?? `${this.ref.backend} does not support live continuation`,
      };
    }
    if (!this.session.open) {
      return {
        status: 'session_unavailable',
        reason: `the ${this.ref.backend} session is closed; replacement sessions are disabled`,
      };
    }
    if (this.pendingKey) return { status: 'busy', activeKey: this.pendingKey };

    const nextRound = this.continuationTurns + 1;
    this.pendingKey = idempotencyKey;
    let sent = false;
    try {
      sent = this.session.sendMessage([{ type: 'text', text: feedback }]);
    } catch {
      sent = false;
    }
    if (!sent) {
      this.pendingKey = undefined;
      return {
        status: 'session_unavailable',
        reason: `the ${this.ref.backend} session rejected the continuation; replacement sessions are disabled`,
      };
    }

    this.continuationTurns = nextRound;
    this.acceptedKeys.set(idempotencyKey, nextRound);
    return { status: 'sent', round: nextRound };
  }

  /** Complete the single pending turn so the next bounded repair can proceed. */
  completeTurn(idempotencyKey: string): boolean {
    if (this.pendingKey !== idempotencyKey) return false;
    this.pendingKey = undefined;
    return true;
  }

  get metrics(): SessionContinuationMetrics {
    return {
      sessionStarts: this.ref.origin === 'started' ? 1 : 0,
      sessionResumptions: this.ref.origin === 'resumed' ? 1 : 0,
      continuationTurns: this.continuationTurns,
      duplicateRequests: this.duplicateRequests,
    };
  }
}

/** Bind the runner's provider contract to its already-open session. */
export function createSessionContinuation(
  runner: Pick<AgentRunner, 'backend'>,
  ref: Omit<AgentSessionRef, 'backend'>,
  session: Pick<AgentSession, 'open' | 'sendMessage'>,
): AgentSessionContinuation {
  return new AgentSessionContinuation(
    { ...ref, backend: runner.backend },
    session,
    SESSION_CONTINUATION_CAPABILITIES[runner.backend],
  );
}
