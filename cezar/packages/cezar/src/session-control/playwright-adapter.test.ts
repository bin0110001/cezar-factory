import { writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  createPlaywrightSessionControl,
  type PlaywrightBrowser,
  type PlaywrightBrowserContext,
  type PlaywrightPage,
} from './playwright-adapter.ts';

function fixture(capability: 'observe' | 'control' = 'control', leaseValid = true) {
  let routeHandler: ((route: { request(): { url(): string }; abort(): Promise<void>; continue(): Promise<void> }) => Promise<void>) | undefined;
  const abort = vi.fn(async () => undefined);
  const proceed = vi.fn(async () => undefined);
  const click = vi.fn(async () => undefined);
  const stopTrace = vi.fn(async ({ path }: { path: string }) => writeFile(path, Buffer.from('trace')));
  const closeContext = vi.fn(async () => undefined);
  const page = {
    title: async () => 'Example', url: () => 'https://example.test/',
    evaluate: async () => 'complete', screenshot: async () => Buffer.from('image'),
    getByRole: () => ({ click, fill: vi.fn(), waitFor: vi.fn(), ariaSnapshot: async () => '- button "Continue"' }),
    getByText: () => ({ click, fill: vi.fn(), waitFor: vi.fn(), ariaSnapshot: async () => '' }),
    getByTestId: () => ({ click, fill: vi.fn(), waitFor: vi.fn(), ariaSnapshot: async () => '' }),
    locator: () => ({ click, fill: vi.fn(), waitFor: vi.fn(), ariaSnapshot: async () => '- button "Continue"' }),
    keyboard: { press: vi.fn(async () => undefined) }, mouse: { wheel: vi.fn(async () => undefined) },
    goto: vi.fn(async () => undefined), waitForLoadState: vi.fn(async () => undefined), waitForURL: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
  } as unknown as PlaywrightPage;
  const context = {
    newPage: async () => page,
    route: vi.fn(async (_url: string, handler: typeof routeHandler) => { routeHandler = handler; }),
    tracing: { start: vi.fn(async () => undefined), stop: stopTrace }, close: closeContext,
  } as unknown as PlaywrightBrowserContext;
  const browser = { version: () => '140.0.7339.16', newContext: vi.fn(async () => context) } as unknown as PlaywrightBrowser;
  const saveArtifact = vi.fn(async ({ name }: { name: string }) => `artifact/${name}`);
  const recordEvent = vi.fn();
  const create = () => createPlaywrightSessionControl({
    browser, expectedBrowserVersion: '140.0.7339.16', runId: 'run-1', attemptId: 'attempt-2', sessionId: 'session-3', capability,
    allowedOrigins: ['https://example.test'], isLeaseValid: () => leaseValid,
    saveArtifact, recordEvent, now: () => 1_700_000_000_000,
  });
  return { create, browser, context, page, saveArtifact, recordEvent, click, stopTrace, closeContext, abort, proceed, route: () => routeHandler };
}

describe('Playwright session-control adapter', () => {
  it('creates an isolated context with service workers and downloads disabled', async () => {
    const f = fixture();
    await f.create();
    expect(f.browser.newContext).toHaveBeenCalledWith({ serviceWorkers: 'block', acceptDownloads: false });
    expect(f.context.tracing.start).toHaveBeenCalledWith({ screenshots: true, snapshots: true, sources: false });
  });

  it('refuses a browser whose executable version differs from the pinned session runtime', async () => {
    const f = fixture();
    await expect(createPlaywrightSessionControl({
      browser: f.browser, expectedBrowserVersion: '141.0.0.0', runId: 'run-1', attemptId: 'attempt-2', sessionId: 'session-3',
      capability: 'observe', allowedOrigins: ['https://example.test'], isLeaseValid: () => true,
      saveArtifact: f.saveArtifact, recordEvent: f.recordEvent,
    })).rejects.toThrow('does not match the pinned session runtime');
    expect(f.browser.newContext).not.toHaveBeenCalled();
  });

  it('enforces exact origin policy for every network request and navigation', async () => {
    const f = fixture();
    const control = await f.create();
    await f.route()!({ request: () => ({ url: () => 'https://other.test/data' }), abort: f.abort, continue: f.proceed });
    expect(f.abort).toHaveBeenCalledOnce();
    await f.route()!({ request: () => ({ url: () => 'https://example.test/data' }), abort: f.abort, continue: f.proceed });
    expect(f.proceed).toHaveBeenCalledOnce();
    const result = await control.handle({ schemaVersion: 1, requestId: 'r1', sessionId: 'session-3', action: { type: 'navigate', url: 'https://other.test/' } });
    expect(result).toMatchObject({ ok: false, error: { code: 'denied_control' } });
    expect(f.page.goto).not.toHaveBeenCalled();
  });

  it('denies input in observe-only mode and stale leases', async () => {
    const observer = await fixture('observe').create();
    const click = { schemaVersion: 1, requestId: 'r2', sessionId: 'session-3', action: { type: 'click', target: { kind: 'role', value: 'button' } } };
    await expect(observer.handle(click)).resolves.toMatchObject({ ok: false, error: { code: 'denied_control' } });
    const staleFixture = fixture('control', false);
    const stale = await staleFixture.create();
    await expect(stale.handle({ ...click, requestId: 'r3' })).resolves.toMatchObject({ ok: false, error: { code: 'stale_lease' } });
    expect(staleFixture.closeContext).toHaveBeenCalledOnce();
  });

  it('stores bounded screenshots and emits a sanitized attempt-linked action event', async () => {
    const f = fixture();
    const control = await f.create();
    await control.handle({ schemaVersion: 1, requestId: 'r4', sessionId: 'session-3', action: { type: 'click', target: { kind: 'role', value: 'button' } } });
    expect(f.click).toHaveBeenCalledOnce();
    expect(f.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1', attemptId: 'attempt-2', sessionId: 'session-3', action: 'click', outcome: 'completed' }));
    expect(JSON.stringify(f.recordEvent.mock.calls)).not.toContain('password');
    await expect(control.handle({ schemaVersion: 1, requestId: 'r5', sessionId: 'session-3', action: { type: 'screenshot', format: 'png' } })).resolves.toMatchObject({ ok: true, result: { kind: 'screenshot', reference: 'artifact/screenshot.png', mediaType: 'image/png' } });
  });

  it('writes one trace artifact and closes idempotently on cleanup', async () => {
    const f = fixture();
    const control = await f.create();
    await control.close();
    await control.close();
    expect(f.stopTrace).toHaveBeenCalledOnce();
    expect(f.saveArtifact).toHaveBeenCalledWith(expect.objectContaining({ name: 'trace.zip', mediaType: 'application/zip' }));
    expect(f.closeContext).toHaveBeenCalledOnce();
  });

  it('turns a stop request into idempotent trace finalization and rejects later actions', async () => {
    const f = fixture();
    const control = await f.create();
    await expect(control.handle({ schemaVersion: 1, requestId: 'stop', sessionId: 'session-3', action: { type: 'requestStop', reason: 'finished' } })).resolves.toMatchObject({ ok: true, result: { kind: 'action', completed: true } });
    await expect(control.handle({ schemaVersion: 1, requestId: 'after', sessionId: 'session-3', action: { type: 'metadata' } })).resolves.toMatchObject({ ok: false, error: { code: 'lost_worker' } });
    await control.close();
    expect(f.stopTrace).toHaveBeenCalledOnce();
    expect(f.closeContext).toHaveBeenCalledOnce();
  });
});
