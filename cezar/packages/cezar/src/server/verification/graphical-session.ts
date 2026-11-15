/**
 * Disposable Linux software-rendered GUI session (#339, parent #328).
 *
 * Uses upstream Xvfb + Mesa (llvmpipe); nothing here is a display server.
 * A session reserves an exclusive display lease through the existing
 * ResourceLockManager (#112), provisions a private temp dir, starts Xvfb,
 * waits for readiness, launches a generic app, health-checks it, captures a
 * bounded screenshot plus renderer fingerprint, then tears down the whole
 * process tree and releases the lease and temp state on every exit path
 * (success, failure, timeout, cancel, disconnect, stale fencing).
 *
 * Passing evidence is returned only when the capture completed AND the fence
 * (#214) was still current at the end. Anything else is never a pass.
 * Software rendering only: this does not claim hardware GPU acceleration.
 */
import { ResourceLockManager, type Lease } from './resource-locks.ts';

export interface SessionProcess {
  pid: number;
  /** Resolves when the process exits. */
  exited: Promise<{ code: number | null; signal: string | null }>;
  /** Terminate the process and all its descendants; must be idempotent. */
  killTree(): Promise<void>;
}

export interface SessionHost {
  makeTempDir(prefix: string): Promise<string>;
  removeDir(path: string): Promise<void>;
  spawn(command: string, args: string[], env: Record<string, string>, cwd: string): Promise<SessionProcess>;
  /** True when an X server answers on the display. */
  displayReady(display: string): Promise<boolean>;
  /** Write a screenshot of the display to path; returns byte size written. */
  capture(display: string, path: string): Promise<number>;
  /** Renderer fingerprint (e.g. GL_RENDERER) as seen on the display. */
  fingerprint(display: string): Promise<string>;
  sleep(ms: number): Promise<void>;
}

export interface GraphicalSessionSpec {
  owner: string;
  /** Candidate display numbers; the lowest free one is leased. */
  displays: number[];
  app: { command: string; args?: string[] };
  xvfbArgs?: string[];
  screen?: string;
  readyTimeoutMs?: number;
  /** Time the app must stay alive before capture (health check). */
  settleMs?: number;
  maxScreenshotBytes?: number;
  leaseTtlMs?: number;
  /** Fencing token of the owning execution (#214). */
  fencingToken: number;
  /** False once a newer owner has taken over; checked before and after work. */
  isFenceCurrent: (token: number) => boolean;
  signal?: AbortSignal;
  /** Simulates a lost worker connection; aborts like cancel but reports disconnect. */
  isConnected?: () => boolean;
  /** Called with the evidence before teardown (the screenshot is deleted with the temp dir). */
  onEvidence?: (evidence: SessionEvidence) => Promise<void>;
}

export type SessionStatus = 'passed' | 'failed' | 'cancelled' | 'disconnected' | 'fenced' | 'contended';

export interface SessionEvidence {
  display: string;
  screenshotPath: string;
  screenshotBytes: number;
  rendererFingerprint: string;
  software: boolean;
}

export interface SessionResult {
  status: SessionStatus;
  reason?: string;
  /** Present only when status === 'passed'. */
  evidence?: SessionEvidence;
  /** True when every resource was released. A false value is never a pass. */
  cleanedUp: boolean;
  cleanupErrors: string[];
}

const SOFTWARE_RENDERER = /llvmpipe|softpipe|swrast|software/i;

export function isSoftwareRenderer(fingerprint: string): boolean {
  return SOFTWARE_RENDERER.test(fingerprint);
}

class Stop extends Error {
  readonly status: SessionStatus;
  constructor(status: SessionStatus, reason: string) { super(reason); this.status = status; }
}

export async function runGraphicalSession(
  spec: GraphicalSessionSpec,
  host: SessionHost,
  locks: ResourceLockManager,
): Promise<SessionResult> {
  if (!spec.isFenceCurrent(spec.fencingToken)) {
    return { status: 'fenced', reason: 'stale fencing token at start', cleanedUp: true, cleanupErrors: [] };
  }
  const acquired = acquireDisplay(spec, locks);
  if (!acquired) {
    return { status: 'contended', reason: 'no display lease available', cleanedUp: true, cleanupErrors: [] };
  }
  const { lease, display } = acquired;
  const procs: SessionProcess[] = [];
  let tempDir: string | undefined;
  let outcome: Omit<SessionResult, 'cleanedUp' | 'cleanupErrors'>;

  try {
    const check = () => {
      if (spec.signal?.aborted) throw new Stop('cancelled', 'cancelled');
      if (spec.isConnected && !spec.isConnected()) throw new Stop('disconnected', 'worker disconnected');
      if (!spec.isFenceCurrent(spec.fencingToken)) throw new Stop('fenced', 'stale fencing token');
      locks.renew(lease.id, spec.leaseTtlMs);
    };
    tempDir = await host.makeTempDir('graphical-session-');
    const env = { DISPLAY: display, LIBGL_ALWAYS_SOFTWARE: '1', XDG_RUNTIME_DIR: tempDir, HOME: tempDir };

    check();
    const xvfb = await host.spawn(
      'Xvfb',
      [display, '-screen', '0', spec.screen ?? '1280x720x24', '-nolisten', 'tcp', ...(spec.xvfbArgs ?? [])],
      env, tempDir,
    );
    procs.push(xvfb);
    const xvfbExit = xvfb.exited.then((e) => { throw new Stop('failed', `Xvfb exited (code ${e.code})`); });
    xvfbExit.catch(() => undefined);

    // Readiness: poll until the display answers or the timeout elapses.
    const readyDeadline = spec.readyTimeoutMs ?? 5_000;
    let waited = 0;
    for (;;) {
      check();
      if (await Promise.race([host.displayReady(display), xvfbExit])) break;
      if (waited >= readyDeadline) throw new Stop('failed', `display ${display} not ready within ${readyDeadline}ms`);
      await host.sleep(50);
      waited += 50;
    }

    const app = await host.spawn(spec.app.command, spec.app.args ?? [], env, tempDir);
    procs.push(app);
    let appExit: { code: number | null; signal: string | null } | undefined;
    void app.exited.then((e) => { appExit = e; });

    // Health check: the app must survive the settle window.
    await host.sleep(spec.settleMs ?? 500);
    check();
    if (appExit) throw new Stop('failed', `app exited before capture (code ${appExit.code}, signal ${appExit.signal})`);

    const screenshotPath = `${tempDir}/screenshot.png`;
    const bytes = await host.capture(display, screenshotPath);
    const max = spec.maxScreenshotBytes ?? 10 * 1024 * 1024;
    if (!(bytes > 0)) throw new Stop('failed', 'screenshot is empty');
    if (bytes > max) throw new Stop('failed', `screenshot ${bytes} bytes exceeds bound ${max}`);
    const rendererFingerprint = (await host.fingerprint(display)).trim();
    if (!rendererFingerprint) throw new Stop('failed', 'no renderer fingerprint');
    check();
    if (appExit) throw new Stop('failed', 'app exited during capture');
    const evidence: SessionEvidence = {
      display, screenshotPath, screenshotBytes: bytes, rendererFingerprint,
      software: isSoftwareRenderer(rendererFingerprint),
    };
    await spec.onEvidence?.(evidence);
    outcome = { status: 'passed', evidence };
  } catch (error) {
    outcome = error instanceof Stop
      ? { status: error.status, reason: error.message }
      : { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }

  const cleanupErrors: string[] = [];
  for (const p of procs.reverse()) {
    try { await p.killTree(); } catch (e) { cleanupErrors.push(`kill ${p.pid}: ${msg(e)}`); }
  }
  if (tempDir) {
    try { await host.removeDir(tempDir); } catch (e) { cleanupErrors.push(`remove ${tempDir}: ${msg(e)}`); }
  }
  if (!locks.release(lease.id)) cleanupErrors.push(`lease ${lease.id} already gone`);

  const cleanedUp = cleanupErrors.length === 0;
  // The screenshot lives in the temp dir and is consumed via onEvidence before
  // teardown; a failed cleanup or lost fence voids the pass.
  if (outcome.status === 'passed' && (!cleanedUp || !spec.isFenceCurrent(spec.fencingToken))) {
    return {
      status: cleanedUp ? 'fenced' : 'failed',
      reason: cleanedUp ? 'stale fencing token at completion' : 'cleanup failed',
      cleanedUp, cleanupErrors,
    };
  }
  return { ...outcome, cleanedUp, cleanupErrors };
}

function acquireDisplay(spec: GraphicalSessionSpec, locks: ResourceLockManager): { lease: Lease; display: string } | null {
  for (const n of [...spec.displays].sort((a, b) => a - b)) {
    const lease = locks.tryAcquire(spec.owner, [{ resource: `display::${n}`, mode: 'exclusive' }], spec.leaseTtlMs);
    if (lease) return { lease, display: `:${n}` };
  }
  return null;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
