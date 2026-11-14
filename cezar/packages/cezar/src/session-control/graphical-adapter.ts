import { createHash } from 'node:crypto';
import type { GraphicalSessionOutcome, GraphicalSessionRequest } from '@open-mercato/cezar-contract';

/**
 * Project-owned lifecycle hooks. The worker core only calls these; it knows nothing about the
 * application (Godot, Blender, generic) behind them and runs no application-specific loop.
 */
export interface GraphicalAppHooks<Handle = unknown> {
  launch(request: GraphicalSessionRequest, signal: AbortSignal): Promise<Handle>;
  /** Resolves true when the application is rendering; false/throw is a readiness failure. */
  ready(handle: Handle, signal: AbortSignal): Promise<boolean>;
  captureFrame(handle: Handle, signal: AbortSignal): Promise<Uint8Array>;
  /** Must be safe to call after a crash; failure here is reported as an orphaned child. */
  quit(handle: Handle): Promise<void>;
}

export interface GraphicalFrameEvidence {
  kind: 'screenshot';
  bytes: number;
  sha256: string;
}

export interface GraphicalSessionResult {
  outcome: GraphicalSessionOutcome;
  frame?: GraphicalFrameEvidence;
  /** Only the captured frame can satisfy a rendered criterion; failures never carry one. */
  renderedCriterionSatisfied: boolean;
}

export interface RunGraphicalSessionOptions {
  sessionId: string;
  signal?: AbortSignal;
}

const fail = (sessionId: string, reason: NonNullable<GraphicalSessionOutcome['reason']>, status: 'failed' | 'cancelled' = 'failed'): GraphicalSessionResult => ({
  outcome: { schemaVersion: 1, sessionId, status, reason },
  renderedCriterionSatisfied: false,
});

/** Runs launch -> ready -> capture -> quit with a hard deadline, always cleaning up. */
export async function runGraphicalSession<H>(
  request: GraphicalSessionRequest,
  hooks: GraphicalAppHooks<H>,
  options: RunGraphicalSessionOptions,
): Promise<GraphicalSessionResult> {
  const { sessionId } = options;
  // A headless session creates no rendering context, so it can never produce a rendered frame.
  if (request.mode === 'headless') return fail(sessionId, 'unsupported_renderer');

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('timeout')), request.timeoutMs);
  let timedOut = false;
  controller.signal.addEventListener('abort', () => { timedOut = !options.signal?.aborted; }, { once: true });
  const guarded = <T>(work: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    if (controller.signal.aborted) { void work.catch(() => undefined); reject(new Error('aborted')); return; }
    const abort = () => reject(new Error('aborted'));
    controller.signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort));
  });

  let handle: H | undefined;
  let launched = false;
  let result: GraphicalSessionResult;
  try {
    try {
      handle = await guarded(hooks.launch(request, controller.signal));
      launched = true;
    } catch {
      result = options.signal?.aborted ? fail(sessionId, 'cancelled', 'cancelled') : fail(sessionId, timedOut ? 'startup_timeout' : 'startup_timeout');
      return result;
    }
    let ready = false;
    try { ready = await guarded(hooks.ready(handle, controller.signal)); } catch { ready = false; }
    if (!ready) {
      result = options.signal?.aborted ? fail(sessionId, 'cancelled', 'cancelled') : fail(sessionId, timedOut ? 'hung_application' : 'startup_timeout');
    } else {
      try {
        const bytes = await guarded(hooks.captureFrame(handle, controller.signal));
        if (bytes.byteLength === 0) {
          result = fail(sessionId, 'unsupported_renderer');
        } else {
          result = {
            outcome: { schemaVersion: 1, sessionId, status: 'completed' },
            frame: { kind: 'screenshot', bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') },
            renderedCriterionSatisfied: true,
          };
        }
      } catch {
        result = options.signal?.aborted ? fail(sessionId, 'cancelled', 'cancelled') : fail(sessionId, timedOut ? 'hung_application' : 'unsupported_renderer');
      }
    }
    return result;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    if (launched) {
      try { await hooks.quit(handle as H); } catch {
        // Cleanup failure downgrades any earlier success: a leaked process is never a pass.
        result = fail(sessionId, 'orphaned_child');
        // eslint-disable-next-line no-unsafe-finally
        return result;
      }
    }
  }
}
