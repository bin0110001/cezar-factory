import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SESSION_CONTROL_LIMITS,
  sessionControlActionAllowed,
  sessionControlRateLimited,
  sessionControlRequestSchema,
  sessionControlResponseSchema,
  type SessionControlAction,
  type SessionControlCapability,
  type SessionControlRequest,
  type SessionControlResponse,
} from '@open-mercato/cezar-contract';

/** Minimal structural Playwright surface keeps the adapter usable by an injected, pinned executor. */
export interface PlaywrightLocator {
  click(options?: { timeout?: number }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  waitFor(options: { state: 'visible'; timeout?: number }): Promise<void>;
  ariaSnapshot(): Promise<string>;
}

export interface PlaywrightPage {
  title(): Promise<string>;
  url(): string;
  evaluate<T>(fn: () => T): Promise<T>;
  screenshot(options: { type: 'png' | 'jpeg'; fullPage: boolean; timeout?: number }): Promise<Uint8Array>;
  getByRole(role: string, options?: { name?: string }): PlaywrightLocator;
  getByText(text: string, options?: { exact?: boolean }): PlaywrightLocator;
  getByTestId(testId: string): PlaywrightLocator;
  locator(selector: string): PlaywrightLocator;
  keyboard: { press(key: string): Promise<void> };
  mouse: { wheel(deltaX: number, deltaY: number): Promise<void> };
  goto(url: string, options: { waitUntil: 'domcontentloaded' | 'load' | 'networkidle'; timeout: number }): Promise<unknown>;
  waitForLoadState(state: 'domcontentloaded', options: { timeout: number }): Promise<void>;
  waitForURL(url: string, options: { timeout: number }): Promise<void>;
  close(): Promise<void>;
}

export interface PlaywrightBrowserContext {
  newPage(): Promise<PlaywrightPage>;
  route(url: string, handler: (route: { request(): { url(): string }; abort(): Promise<void>; continue(): Promise<void> }) => Promise<void>): Promise<void>;
  tracing: { start(options: { screenshots: boolean; snapshots: boolean; sources: boolean }): Promise<void>; stop(options: { path: string }): Promise<void> };
  close(): Promise<void>;
}

export interface PlaywrightBrowser {
  version(): string;
  newContext(options: { serviceWorkers: 'block'; acceptDownloads: false }): Promise<PlaywrightBrowserContext>;
}

export interface SessionControlTraceEvent {
  runId: string;
  attemptId: string;
  sessionId: string;
  requestId: string;
  timestamp: string;
  action: SessionControlAction['type'];
  outcome: 'completed' | 'failed' | 'denied';
  errorCode?: string;
}

export interface PlaywrightSessionOptions {
  browser: PlaywrightBrowser;
  expectedBrowserVersion: string;
  runId: string;
  attemptId: string;
  sessionId: string;
  capability: SessionControlCapability;
  allowedOrigins: string[];
  isLeaseValid: () => boolean;
  saveArtifact: (input: { sessionId: string; name: 'screenshot.png' | 'screenshot.jpeg' | 'trace.zip'; bytes: Uint8Array; mediaType: string }) => Promise<string>;
  recordEvent: (event: SessionControlTraceEvent) => Promise<void> | void;
  now?: () => number;
}

export interface PlaywrightSessionControl {
  handle(input: unknown): Promise<SessionControlResponse>;
  close(): Promise<void>;
}

const parseOrigin = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
};

const MAX_TRACE_BYTES = 8 * 1024 * 1024;

function targetLocator(page: PlaywrightPage, target: Exclude<SessionControlAction, { type: 'metadata' | 'screenshot' | 'accessibilitySnapshot' | 'navigate' | 'key' | 'scroll' | 'waitForCondition' | 'requestStop' }>['target']): PlaywrightLocator {
  switch (target.kind) {
    case 'selector': return page.locator(target.value);
    case 'role': return page.getByRole(target.value, target.name ? { name: target.name } : undefined);
    case 'text': return page.getByText(target.value, { exact: true });
    case 'testId': return page.getByTestId(target.value);
  }
}

function response(request: Pick<SessionControlRequest, 'requestId' | 'sessionId'>, result: SessionControlResponse extends { ok: true; result: infer T } ? T : never): SessionControlResponse {
  return sessionControlResponseSchema.parse({ ok: true, schemaVersion: 1, requestId: request.requestId, sessionId: request.sessionId, result });
}

function errorResponse(request: Pick<SessionControlRequest, 'requestId' | 'sessionId'>, code: Extract<SessionControlResponse, { ok: false }>['error']['code'], message: string, retryAfterMs?: number): SessionControlResponse {
  return sessionControlResponseSchema.parse({ ok: false, schemaVersion: 1, requestId: request.requestId, sessionId: request.sessionId, error: { code, message: message.slice(0, 512), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } });
}

/** Creates one isolated, attempt-scoped browser context and a bounded control endpoint. */
export async function createPlaywrightSessionControl(options: PlaywrightSessionOptions): Promise<PlaywrightSessionControl> {
  const allowedOrigins = new Set(options.allowedOrigins.map(parseOrigin));
  if (!options.runId || !options.attemptId || !options.sessionId || !options.expectedBrowserVersion || allowedOrigins.size === 0 || allowedOrigins.has(undefined)) {
    throw new Error('session identity, pinned browser version, and exact HTTP(S) origins are required');
  }
  if (options.browser.version() !== options.expectedBrowserVersion) throw new Error('Playwright browser version does not match the pinned session runtime');
  const context = await options.browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
  let page: PlaywrightPage;
  try {
    await context.route('**/*', async (route) => {
      const origin = parseOrigin(route.request().url());
      if (!origin || !allowedOrigins.has(origin)) await route.abort();
      else await route.continue();
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    page = await context.newPage();
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
  const now = options.now ?? Date.now;
  const requestTimes: number[] = [];
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const closeSession = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      const tracePath = join(tmpdir(), `cezar-session-${randomUUID()}.zip`);
      try {
        await context.tracing.stop({ path: tracePath });
        if ((await stat(tracePath)).size > MAX_TRACE_BYTES) throw new Error('browser trace exceeds capture limit');
        const bytes = new Uint8Array(await readFile(tracePath));
        await options.saveArtifact({ sessionId: options.sessionId, name: 'trace.zip', bytes, mediaType: 'application/zip' });
      } finally {
        await unlink(tracePath).catch(() => undefined);
        await context.close();
      }
    })();
    return closePromise;
  };

  const handle = async (input: unknown): Promise<SessionControlResponse> => {
    const parsed = sessionControlRequestSchema.safeParse(input);
    const fallback = { requestId: parsed.success ? parsed.data.requestId : 'invalid-request', sessionId: options.sessionId };
    if (!parsed.success) return errorResponse(fallback, 'app_not_ready', 'invalid session-control request');
    const request = parsed.data;
    let code: Extract<SessionControlResponse, { ok: false }>['error']['code'] | undefined;
    let outcome: SessionControlTraceEvent['outcome'] = 'completed';
    try {
      if (closed) throw Object.assign(new Error('browser session is closed'), { sessionCode: 'lost_worker' });
      if (request.sessionId !== options.sessionId) throw Object.assign(new Error('request belongs to another session'), { sessionCode: 'wrong_session' });
      if (!options.isLeaseValid()) throw Object.assign(new Error('session lease is no longer valid'), { sessionCode: 'stale_lease' });
      const timestamp = now();
      while (requestTimes.length && requestTimes[0]! <= timestamp - 60_000) requestTimes.shift();
      if (sessionControlRateLimited(requestTimes.length)) throw Object.assign(new Error('session request rate limit exceeded'), { sessionCode: 'rate_limited' });
      requestTimes.push(timestamp);
      if (!sessionControlActionAllowed(options.capability, request.action)) throw Object.assign(new Error('interactive control is not enabled for this session'), { sessionCode: 'denied_control' });
      const result = await executeAction(page, context, request.action, options);
      if (request.action.type === 'requestStop') await closeSession();
      return response(request, result as never);
    } catch (error) {
      outcome = 'failed';
      code = (error as { sessionCode?: typeof code }).sessionCode ?? 'transient_render';
      if (code === 'denied_control') outcome = 'denied';
      if (code === 'stale_lease') await closeSession().catch(() => undefined);
      const messages = { wrong_session: 'request belongs to another session', stale_lease: 'session lease is no longer valid', denied_control: 'interactive control is not enabled for this session', rate_limited: 'session request rate limit exceeded', lost_worker: 'browser session is unavailable', transient_render: 'browser action did not complete' } as const;
      const message = code && code in messages ? messages[code as keyof typeof messages] : messages.transient_render;
      return errorResponse(request, code ?? 'transient_render', message, code === 'rate_limited' ? 60_000 : undefined);
    } finally {
      const event: SessionControlTraceEvent = { runId: options.runId, attemptId: options.attemptId, sessionId: options.sessionId, requestId: fallback.requestId, timestamp: new Date(now()).toISOString(), action: parsed.success ? parsed.data.action.type : 'metadata', outcome, ...(code ? { errorCode: code } : {}) };
      await options.recordEvent(event);
    }
  };

  return {
    handle,
    close: closeSession,
  };
}

async function executeAction(page: PlaywrightPage, context: PlaywrightBrowserContext, action: SessionControlAction, options: PlaywrightSessionOptions) {
  switch (action.type) {
    case 'metadata': return { kind: 'metadata' as const, title: (await page.title()).slice(0, 512), url: page.url().slice(0, 2_048), readyState: await page.evaluate(() => (globalThis as unknown as { document: { readyState: 'loading' | 'interactive' | 'complete' } }).document.readyState) };
    case 'screenshot': {
      const bytes = new Uint8Array(await page.screenshot({ type: action.format, fullPage: action.fullPage, timeout: 10_000 }));
      if (bytes.byteLength > SESSION_CONTROL_LIMITS.maxScreenshotBytes) throw new Error('screenshot exceeds capture limit');
      const mediaType = action.format === 'png' ? 'image/png' : 'image/jpeg';
      const reference = await options.saveArtifact({ sessionId: options.sessionId, name: `screenshot.${action.format}`, bytes, mediaType });
      return { kind: 'screenshot' as const, reference, mediaType, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    case 'accessibilitySnapshot': {
      const snapshot = await page.locator('body').ariaSnapshot();
      const nodes = snapshot.split('\n').filter(Boolean).slice(0, action.maxNodes).map((line, index) => {
        const match = line.match(/^\s*-\s+([\w-]+)(?:\s+"([^"]*)")?/);
        return { id: String(index), role: (match?.[1] ?? 'unknown').slice(0, 128), name: (match?.[2] ?? '').slice(0, SESSION_CONTROL_LIMITS.maxSnapshotText) };
      });
      return { kind: 'accessibilitySnapshot' as const, nodes, truncated: snapshot.split('\n').filter(Boolean).length > nodes.length };
    }
    case 'navigate': {
      const origin = parseOrigin(action.url);
      if (!origin || !options.allowedOrigins.map(parseOrigin).includes(origin)) throw Object.assign(new Error('navigation origin is not allowed'), { sessionCode: 'denied_control' });
      await page.goto(action.url, { waitUntil: ({ domContentLoaded: 'domcontentloaded', load: 'load', networkIdle: 'networkidle' } as const)[action.waitUntil], timeout: action.timeoutMs });
      return { kind: 'action' as const, completed: true };
    }
    case 'click': await targetLocator(page, action.target).click({ timeout: action.timeoutMs }); return { kind: 'action' as const, completed: true };
    case 'type': await targetLocator(page, action.target).fill(action.text, { timeout: action.timeoutMs }); return { kind: 'action' as const, completed: true };
    case 'key': await page.keyboard.press(action.key); return { kind: 'action' as const, completed: true };
    case 'scroll': await page.mouse.wheel(action.deltaX, action.deltaY); return { kind: 'action' as const, completed: true };
    case 'waitForCondition':
      if (action.condition === 'domReady') await page.waitForLoadState('domcontentloaded', { timeout: action.timeoutMs });
      else if (action.condition === 'targetVisible' && action.target) await targetLocator(page, action.target).waitFor({ state: 'visible', timeout: action.timeoutMs });
      else if (action.condition === 'url' && action.url) await page.waitForURL(action.url, { timeout: action.timeoutMs });
      return { kind: 'action' as const, completed: true };
    case 'requestStop': return { kind: 'action' as const, completed: true };
  }
}
