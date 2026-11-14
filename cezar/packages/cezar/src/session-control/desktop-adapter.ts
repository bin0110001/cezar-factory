import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Per-session desktop adapter (ADR #344). It never talks to a display itself: a maintained backend
 * (AT-SPI for semantics, Selkies/X11 for pixels) is injected and is bound to exactly one session display.
 * Authorization lives here, server-side, and is independent of whatever a client sends.
 */

export const DESKTOP_GRANTS = ['screenshot', 'input', 'clipboard', 'fileTransfer', 'recording'] as const;
export type DesktopGrant = (typeof DESKTOP_GRANTS)[number];

export const DESKTOP_LIMITS = {
  maxRequestsPerMinute: 60,
  maxSessionMs: 3_600_000,
  maxScreenshotBytes: 4_194_304,
  maxClipboardBytes: 65_536,
  maxFileBytes: 1_048_576,
  maxRecordingBytes: 16_777_216,
  maxRecordingMs: 300_000,
  maxTextInput: 4_096,
  maxSnapshotNodes: 500,
  maxSnapshotText: 512,
  maxActionArgsBytes: 8_192,
} as const;

const idSchema = z.string().min(1).max(128);
const elementSchema = z.object({ id: z.string().min(1).max(256) }).strict();
const relativePath = z.string().min(1).max(256).refine((p) => !p.startsWith('/') && !p.includes('\\') && !p.split('/').some((s) => s === '..' || s === ''), 'path must be a relative, normalized session path');

export const desktopActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('accessibilitySnapshot'), maxNodes: z.number().int().min(1).max(DESKTOP_LIMITS.maxSnapshotNodes).default(100) }).strict(),
  z.object({ type: z.literal('screenshot') }).strict(),
  z.object({ type: z.literal('invokeElement'), element: elementSchema, action: z.string().min(1).max(64) }).strict(),
  z.object({ type: z.literal('setElementText'), element: elementSchema, text: z.string().max(DESKTOP_LIMITS.maxTextInput) }).strict(),
  z.object({ type: z.literal('pixelClick'), x: z.number().int().min(0).max(16_384), y: z.number().int().min(0).max(16_384), button: z.enum(['left', 'right', 'middle']).default('left') }).strict(),
  z.object({ type: z.literal('pixelType'), text: z.string().max(DESKTOP_LIMITS.maxTextInput) }).strict(),
  z.object({ type: z.literal('pixelKey'), key: z.string().min(1).max(64) }).strict(),
  z.object({ type: z.literal('clipboardRead') }).strict(),
  z.object({ type: z.literal('clipboardWrite'), text: z.string().max(DESKTOP_LIMITS.maxClipboardBytes) }).strict(),
  z.object({ type: z.literal('fileUpload'), path: relativePath, base64: z.string().max(Math.ceil(DESKTOP_LIMITS.maxFileBytes * 4 / 3) + 4) }).strict(),
  z.object({ type: z.literal('fileDownload'), path: relativePath }).strict(),
  z.object({ type: z.literal('recordingStart') }).strict(),
  z.object({ type: z.literal('recordingStop') }).strict(),
  z.object({ type: z.literal('projectAction'), name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), args: z.record(z.string(), z.unknown()).default({}) }).strict(),
  z.object({ type: z.literal('requestStop') }).strict(),
]);
export type DesktopAction = z.infer<typeof desktopActionSchema>;

export const desktopRequestSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: idSchema,
  sessionId: idSchema,
  action: desktopActionSchema,
}).strict();
export type DesktopRequest = z.infer<typeof desktopRequestSchema>;

export type DesktopErrorCode =
  | 'invalid_request' | 'wrong_session' | 'stale_lease' | 'denied_grant' | 'suspended_by_takeover'
  | 'rate_limited' | 'session_expired' | 'closed' | 'unknown_project_action' | 'inaccessible_widget'
  | 'capture_too_large' | 'action_failed';

export type DesktopResponse =
  | { ok: true; schemaVersion: 1; requestId: string; sessionId: string; result: Record<string, unknown> }
  | { ok: false; schemaVersion: 1; requestId: string; sessionId: string; error: { code: DesktopErrorCode; message: string; retryAfterMs?: number } };

/** Which grant every action needs. Semantic reads are observation only; pixel input needs screenshot + input. */
export function requiredDesktopGrants(action: DesktopAction): DesktopGrant[] {
  switch (action.type) {
    case 'accessibilitySnapshot': case 'requestStop': return [];
    case 'screenshot': return ['screenshot'];
    case 'invokeElement': case 'setElementText': case 'projectAction': return ['input'];
    case 'pixelClick': case 'pixelType': case 'pixelKey': return ['screenshot', 'input'];
    case 'clipboardRead': case 'clipboardWrite': return ['clipboard'];
    case 'fileUpload': case 'fileDownload': return ['fileTransfer'];
    case 'recordingStart': case 'recordingStop': return ['recording'];
  }
}

export function isInputAction(action: DesktopAction): boolean {
  return requiredDesktopGrants(action).includes('input');
}

export interface DesktopNode { id: string; role: string; name: string; disabled?: boolean }

/** Narrow backend surface. Implementations (AT-SPI client, Selkies/xdotool-style input) are injected and pinned. */
export interface DesktopBackend {
  /** Display this backend is attached to; must equal the session's own display. */
  readonly display: string;
  /** Effective uid the application and adapter run as. Must not be root. */
  readonly uid: number;
  snapshot(maxNodes: number): Promise<{ nodes: DesktopNode[]; truncated: boolean }>;
  invoke(elementId: string, action: string): Promise<void>;
  setText(elementId: string, text: string): Promise<void>;
  screenshot(): Promise<Uint8Array>;
  pixelClick(x: number, y: number, button: 'left' | 'right' | 'middle'): Promise<void>;
  pixelType(text: string): Promise<void>;
  pixelKey(key: string): Promise<void>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  putFile(path: string, bytes: Uint8Array): Promise<void>;
  getFile(path: string): Promise<Uint8Array>;
  startRecording(): Promise<void>;
  stopRecording(): Promise<Uint8Array>;
  /** Idempotent: release display, input and clipboard handles and delete session scratch. */
  close(): Promise<void>;
}

/** Project-owned semantic action (e.g. a project skill's create_room). The core knows nothing about its meaning. */
export interface DesktopProjectAction {
  name: string;
  argsSchema: z.ZodType<Record<string, unknown>>;
  run(args: Record<string, unknown>): Promise<Record<string, string | number | boolean>>;
}

export interface DesktopTraceEvent {
  runId: string; attemptId: string; sessionId: string; requestId: string; timestamp: string;
  action: DesktopAction['type'] | 'invalid';
  outcome: 'completed' | 'failed' | 'denied';
  errorCode?: DesktopErrorCode;
}

export interface DesktopSessionOptions {
  backend: DesktopBackend;
  display: string;
  runId: string; attemptId: string; sessionId: string;
  /** Empty by default: a session is view-only (semantic snapshot) until a grant is explicit. */
  grants?: readonly DesktopGrant[];
  projectActions?: readonly DesktopProjectAction[];
  isLeaseValid: () => boolean;
  saveArtifact: (input: { sessionId: string; name: string; bytes: Uint8Array; mediaType: string }) => Promise<string>;
  recordEvent: (event: DesktopTraceEvent) => Promise<void> | void;
  limits?: { maxRequestsPerMinute?: number; maxSessionMs?: number; maxRecordingMs?: number };
  now?: () => number;
}

export interface DesktopSessionControl {
  handle(input: unknown): Promise<DesktopResponse>;
  /** Human takeover: immediately suspends agent input; one owner at a time. */
  takeOver(owner: string): void;
  /** Resume requires a fresh authorization decision; a stale agent cannot regain control by replay. */
  resume(authorize: () => Promise<boolean>): Promise<boolean>;
  readonly takeoverOwner: string | undefined;
  /** Disconnect and cancel both land here. Idempotent. */
  close(): Promise<void>;
}

const MESSAGES: Record<DesktopErrorCode, string> = {
  invalid_request: 'invalid desktop request',
  wrong_session: 'request belongs to another session',
  stale_lease: 'session lease is no longer valid',
  denied_grant: 'the session has not been granted this capability',
  suspended_by_takeover: 'agent input is suspended during human takeover',
  rate_limited: 'session request rate limit exceeded',
  session_expired: 'session time limit exceeded',
  closed: 'desktop session is closed',
  unknown_project_action: 'project action is not registered for this session',
  inaccessible_widget: 'element is missing, stale or not exposed by accessibility',
  capture_too_large: 'capture exceeds the configured limit',
  action_failed: 'desktop action did not complete',
};

class DesktopError extends Error {
  constructor(readonly code: DesktopErrorCode) { super(MESSAGES[code]); }
}

const ok = (r: Pick<DesktopRequest, 'requestId' | 'sessionId'>, result: Record<string, unknown>): DesktopResponse => ({ ok: true, schemaVersion: 1, requestId: r.requestId, sessionId: r.sessionId, result });
const fail = (r: { requestId: string; sessionId: string }, code: DesktopErrorCode, retryAfterMs?: number): DesktopResponse => ({ ok: false, schemaVersion: 1, requestId: r.requestId, sessionId: r.sessionId, error: { code, message: MESSAGES[code], ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } });

export async function createDesktopSessionControl(options: DesktopSessionOptions): Promise<DesktopSessionControl> {
  if (!options.runId || !options.attemptId || !options.sessionId || !options.display) throw new Error('session identity and display are required');
  if (options.backend.display !== options.display) {
    await options.backend.close().catch(() => undefined);
    throw new Error('desktop backend is not attached to the session display');
  }
  if (!Number.isInteger(options.backend.uid) || options.backend.uid === 0) {
    await options.backend.close().catch(() => undefined);
    throw new Error('desktop session must run as a low-privilege user');
  }
  const registry = new Map<string, DesktopProjectAction>();
  for (const action of options.projectActions ?? []) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(action.name) || registry.has(action.name)) throw new Error(`invalid or duplicate project action: ${action.name}`);
    registry.set(action.name, action);
  }
  const grants = new Set<DesktopGrant>(options.grants ?? []);
  const now = options.now ?? Date.now;
  const maxPerMinute = options.limits?.maxRequestsPerMinute ?? DESKTOP_LIMITS.maxRequestsPerMinute;
  const maxSessionMs = options.limits?.maxSessionMs ?? DESKTOP_LIMITS.maxSessionMs;
  const maxRecordingMs = options.limits?.maxRecordingMs ?? DESKTOP_LIMITS.maxRecordingMs;
  const startedAt = now();
  const requestTimes: number[] = [];
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let owner: string | undefined;
  let recordingStartedAt: number | undefined;

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    grants.clear();
    recordingStartedAt = undefined;
    registry.clear();
    closePromise = options.backend.close();
    return closePromise;
  };

  const execute = async (action: DesktopAction): Promise<Record<string, unknown>> => {
    const b = options.backend;
    switch (action.type) {
      case 'accessibilitySnapshot': {
        const snap = await b.snapshot(action.maxNodes);
        const nodes = snap.nodes.slice(0, action.maxNodes).map((n) => ({ id: n.id.slice(0, 256), role: n.role.slice(0, 128), name: n.name.slice(0, DESKTOP_LIMITS.maxSnapshotText), ...(n.disabled === undefined ? {} : { disabled: n.disabled }) }));
        return { kind: 'accessibilitySnapshot', nodes, truncated: snap.truncated || snap.nodes.length > nodes.length };
      }
      case 'screenshot': {
        const bytes = await b.screenshot();
        if (bytes.byteLength > DESKTOP_LIMITS.maxScreenshotBytes) throw new DesktopError('capture_too_large');
        const reference = await options.saveArtifact({ sessionId: options.sessionId, name: 'desktop-screenshot.png', bytes, mediaType: 'image/png' });
        return { kind: 'screenshot', reference, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
      }
      case 'invokeElement': await b.invoke(action.element.id, action.action); return { kind: 'action', completed: true };
      case 'setElementText': await b.setText(action.element.id, action.text); return { kind: 'action', completed: true };
      case 'pixelClick': await b.pixelClick(action.x, action.y, action.button); return { kind: 'action', completed: true };
      case 'pixelType': await b.pixelType(action.text); return { kind: 'action', completed: true };
      case 'pixelKey': await b.pixelKey(action.key); return { kind: 'action', completed: true };
      case 'clipboardRead': {
        const text = await b.readClipboard();
        if (Buffer.byteLength(text) > DESKTOP_LIMITS.maxClipboardBytes) throw new DesktopError('capture_too_large');
        return { kind: 'clipboard', text };
      }
      case 'clipboardWrite': await b.writeClipboard(action.text); return { kind: 'action', completed: true };
      case 'fileUpload': {
        const bytes = new Uint8Array(Buffer.from(action.base64, 'base64'));
        if (bytes.byteLength > DESKTOP_LIMITS.maxFileBytes) throw new DesktopError('capture_too_large');
        await b.putFile(action.path, bytes);
        return { kind: 'file', path: action.path, bytes: bytes.byteLength };
      }
      case 'fileDownload': {
        const bytes = await b.getFile(action.path);
        if (bytes.byteLength > DESKTOP_LIMITS.maxFileBytes) throw new DesktopError('capture_too_large');
        const reference = await options.saveArtifact({ sessionId: options.sessionId, name: 'desktop-download.bin', bytes, mediaType: 'application/octet-stream' });
        return { kind: 'file', reference, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
      }
      case 'recordingStart':
        if (recordingStartedAt !== undefined) throw new DesktopError('action_failed');
        await b.startRecording();
        recordingStartedAt = now();
        return { kind: 'action', completed: true };
      case 'recordingStop': {
        if (recordingStartedAt === undefined) throw new DesktopError('action_failed');
        const elapsed = now() - recordingStartedAt;
        recordingStartedAt = undefined;
        const bytes = await b.stopRecording();
        if (bytes.byteLength > DESKTOP_LIMITS.maxRecordingBytes || elapsed > maxRecordingMs) throw new DesktopError('capture_too_large');
        const reference = await options.saveArtifact({ sessionId: options.sessionId, name: 'desktop-recording.webm', bytes, mediaType: 'video/webm' });
        return { kind: 'recording', reference, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
      }
      case 'projectAction': {
        const registered = registry.get(action.name);
        if (!registered) throw new DesktopError('unknown_project_action');
        if (JSON.stringify(action.args).length > DESKTOP_LIMITS.maxActionArgsBytes) throw new DesktopError('invalid_request');
        const args = registered.argsSchema.safeParse(action.args);
        if (!args.success) throw new DesktopError('invalid_request');
        return { kind: 'projectAction', name: action.name, output: await registered.run(args.data) };
      }
      case 'requestStop': return { kind: 'action', completed: true };
    }
  };

  const handle = async (input: unknown): Promise<DesktopResponse> => {
    const parsed = desktopRequestSchema.safeParse(input);
    const loose = (input ?? {}) as { requestId?: unknown };
    const fallback = { requestId: parsed.success ? parsed.data.requestId : (typeof loose.requestId === 'string' && loose.requestId.length <= 128 && loose.requestId ? loose.requestId : 'invalid-request'), sessionId: options.sessionId };
    let code: DesktopErrorCode | undefined;
    let outcome: DesktopTraceEvent['outcome'] = 'completed';
    try {
      if (!parsed.success) throw new DesktopError('invalid_request');
      const request = parsed.data;
      if (closed) throw new DesktopError('closed');
      if (request.sessionId !== options.sessionId) throw new DesktopError('wrong_session');
      if (!options.isLeaseValid()) throw new DesktopError('stale_lease');
      const timestamp = now();
      if (timestamp - startedAt > maxSessionMs) throw new DesktopError('session_expired');
      while (requestTimes.length && requestTimes[0]! <= timestamp - 60_000) requestTimes.shift();
      if (requestTimes.length >= maxPerMinute) throw new DesktopError('rate_limited');
      requestTimes.push(timestamp);
      if (isInputAction(request.action) && owner !== undefined) throw new DesktopError('suspended_by_takeover');
      if (!requiredDesktopGrants(request.action).every((g) => grants.has(g))) throw new DesktopError('denied_grant');
      let result: Record<string, unknown>;
      try {
        result = await execute(request.action);
      } catch (error) {
        if (error instanceof DesktopError) throw error;
        throw new DesktopError(/stale|not found|no such element|inaccessible/i.test(String((error as Error)?.message)) ? 'inaccessible_widget' : 'action_failed');
      }
      if (request.action.type === 'requestStop') await close();
      return ok(request, result);
    } catch (error) {
      const err = error instanceof DesktopError ? error : new DesktopError('action_failed');
      code = err.code;
      outcome = code === 'denied_grant' || code === 'suspended_by_takeover' ? 'denied' : 'failed';
      if (code === 'stale_lease' || code === 'session_expired') await close().catch(() => undefined);
      return fail(fallback, code, code === 'rate_limited' ? 60_000 : undefined);
    } finally {
      // Only action kind, outcome and identity are recorded: never typed text, clipboard or file contents.
      await options.recordEvent({ runId: options.runId, attemptId: options.attemptId, sessionId: options.sessionId, requestId: fallback.requestId, timestamp: new Date(now()).toISOString(), action: parsed.success ? parsed.data.action.type : 'invalid', outcome, ...(code ? { errorCode: code } : {}) });
    }
  };

  return {
    handle,
    takeOver(who: string) {
      if (closed) throw new Error('desktop session is closed');
      if (!who) throw new Error('takeover owner is required');
      if (owner !== undefined && owner !== who) throw new Error('session is already owned by another human');
      owner = who;
    },
    async resume(authorize) {
      if (closed || owner === undefined) return false;
      if (!(await authorize()) || closed) return false;
      owner = undefined;
      return true;
    },
    get takeoverOwner() { return owner; },
    close,
  };
}
