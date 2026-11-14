import { describe, expect, it, vi } from 'vitest';
import { createDesktopSessionControl, type DesktopBackend, type DesktopGrant } from './desktop-adapter.ts';
import { godotCreateRoomAction } from './godot-pilot.ts';

/** In-memory non-Godot desktop fixture on a "virtual display": one button and one text field. */
function fixture(grants: DesktopGrant[] = [], opts: { display?: string; uid?: number; leaseValid?: () => boolean; maxPerMinute?: number } = {}) {
  const state = { clicks: 0, text: '', clipboard: 'secret', closed: 0, recording: false, files: new Map<string, Uint8Array>() };
  const backend: DesktopBackend = {
    display: opts.display ?? ':77', uid: opts.uid ?? 1001,
    snapshot: async () => ({ nodes: [{ id: 'btn', role: 'push button', name: 'OK' }, { id: 'txt', role: 'text', name: 'Name' }], truncated: false }),
    invoke: async (id) => { if (id !== 'btn') throw new Error('no such element'); state.clicks++; },
    setText: async (_id, text) => { state.text = text; },
    screenshot: async () => new Uint8Array([1, 2, 3]),
    pixelClick: async () => { state.clicks++; }, pixelType: async () => undefined, pixelKey: async () => undefined,
    readClipboard: async () => state.clipboard, writeClipboard: async (t) => { state.clipboard = t; },
    putFile: async (p, b) => { state.files.set(p, b); }, getFile: async (p) => state.files.get(p) ?? new Uint8Array(),
    startRecording: async () => { state.recording = true; }, stopRecording: async () => { state.recording = false; return new Uint8Array([9]); },
    close: async () => { state.closed++; },
  };
  const events: Array<Record<string, unknown>> = [];
  const harness = { run: vi.fn(async (a: string, args: Record<string, string | number | boolean>) => ({ action: a, room: String(args.name) })) };
  let t = 1_700_000_000_000;
  const create = () => createDesktopSessionControl({
    backend, display: ':77', runId: 'run', attemptId: 'att', sessionId: 's1', grants,
    projectActions: [godotCreateRoomAction(harness)],
    isLeaseValid: opts.leaseValid ?? (() => true),
    saveArtifact: async ({ name }) => `artifact/${name}`,
    recordEvent: (e) => { events.push(e as never); },
    limits: opts.maxPerMinute ? { maxRequestsPerMinute: opts.maxPerMinute } : {},
    now: () => t,
  });
  return { create, state, events, harness, advance: (ms: number) => { t += ms; } };
}
const req = (action: Record<string, unknown>, id = 'r1', sessionId = 's1') => ({ schemaVersion: 1, requestId: id, sessionId, action });
const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error?.code);

describe('desktop adapter', () => {
  it('observes and controls the non-Godot fixture through its scoped adapter', async () => {
    const f = fixture(['input', 'screenshot']);
    const s = await f.create();
    const snap = await s.handle(req({ type: 'accessibilitySnapshot' }));
    expect(snap.ok && (snap.result.nodes as unknown[]).length).toBe(2);
    expect(code(await s.handle(req({ type: 'invokeElement', element: { id: 'btn' }, action: 'click' }, 'r2')))).toBe('ok');
    expect(f.state.clicks).toBe(1);
    expect(code(await s.handle(req({ type: 'pixelClick', x: 1, y: 2 }, 'r3')))).toBe('ok');
    const shot = await s.handle(req({ type: 'screenshot' }, 'r4'));
    expect(shot.ok && shot.result.reference).toBe('artifact/desktop-screenshot.png');
  });

  it('read-only session cannot input, use clipboard, transfer files or record', async () => {
    const f = fixture();
    const s = await f.create();
    expect(code(await s.handle(req({ type: 'accessibilitySnapshot' })))).toBe('ok');
    for (const [i, action] of [
      { type: 'invokeElement', element: { id: 'btn' }, action: 'click' }, { type: 'setElementText', element: { id: 'txt' }, text: 'x' },
      { type: 'pixelClick', x: 1, y: 1 }, { type: 'pixelKey', key: 'a' }, { type: 'screenshot' },
      { type: 'clipboardRead' }, { type: 'clipboardWrite', text: 'x' }, { type: 'fileDownload', path: 'a.txt' },
      { type: 'recordingStart' }, { type: 'projectAction', name: 'create_room', args: { name: 'x' } },
    ].entries()) expect(code(await s.handle(req(action, `d${i}`)))).toBe('denied_grant');
    expect(f.state.clicks).toBe(0);
    expect(f.harness.run).not.toHaveBeenCalled();
    expect(f.state.clipboard).toBe('secret');
  });

  it('pixel fallback needs screenshot and input; grants are independent', async () => {
    const f = fixture(['input']);
    const s = await f.create();
    expect(code(await s.handle(req({ type: 'pixelClick', x: 1, y: 1 })))).toBe('denied_grant');
    expect(code(await s.handle(req({ type: 'invokeElement', element: { id: 'btn' }, action: 'click' }, 'r2')))).toBe('ok');
    expect(code(await s.handle(req({ type: 'clipboardRead' }, 'r3')))).toBe('denied_grant');
  });

  it('runs a project-native Godot action through the generic hook and validates its args', async () => {
    const f = fixture(['input']);
    const s = await f.create();
    const r = await s.handle(req({ type: 'projectAction', name: 'create_room', args: { name: 'Lobby' } }));
    expect(r.ok && r.result).toMatchObject({ kind: 'projectAction', name: 'create_room', output: { room: 'Lobby' } });
    expect(code(await s.handle(req({ type: 'projectAction', name: 'create_room', args: { name: '../x' } }, 'r2')))).toBe('invalid_request');
    expect(code(await s.handle(req({ type: 'projectAction', name: 'delete_world', args: {} }, 'r3')))).toBe('unknown_project_action');
  });

  it('transfers clipboard, files and recordings only when granted and bounds them', async () => {
    const f = fixture(['clipboard', 'fileTransfer', 'recording']);
    const s = await f.create();
    expect((await s.handle(req({ type: 'clipboardRead' }))).ok).toBe(true);
    expect(code(await s.handle(req({ type: 'fileUpload', path: '../x', base64: 'AA==' }, 'r2')))).toBe('invalid_request');
    expect(code(await s.handle(req({ type: 'fileUpload', path: 'in/a.txt', base64: 'AA==' }, 'r3')))).toBe('ok');
    expect(code(await s.handle(req({ type: 'recordingStart' }, 'r4')))).toBe('ok');
    expect(code(await s.handle(req({ type: 'recordingStop' }, 'r5')))).toBe('ok');
  });

  it('rejects another session, stale leases, rate overruns and expired sessions', async () => {
    const f = fixture(['input'], { maxPerMinute: 2 });
    const s = await f.create();
    expect(code(await s.handle(req({ type: 'accessibilitySnapshot' }, 'a', 'other')))).toBe('wrong_session');
    await s.handle(req({ type: 'accessibilitySnapshot' }, 'b'));
    await s.handle(req({ type: 'accessibilitySnapshot' }, 'b2'));
    expect(code(await s.handle(req({ type: 'accessibilitySnapshot' }, 'c')))).toBe('rate_limited');
    f.advance(4_000_000);
    expect(code(await s.handle(req({ type: 'accessibilitySnapshot' }, 'd')))).toBe('session_expired');
    expect(f.state.closed).toBe(1);
    const stale = fixture(['input'], { leaseValid: () => false });
    const s2 = await stale.create();
    expect(code(await s2.handle(req({ type: 'accessibilitySnapshot' })))).toBe('stale_lease');
    expect(stale.state.closed).toBe(1);
  });

  it('refuses a backend on another display or running as root', async () => {
    await expect(fixture([], { display: ':0' }).create()).rejects.toThrow(/session display/);
    await expect(fixture([], { uid: 0 }).create()).rejects.toThrow(/low-privilege/);
  });

  it('human takeover suspends agent input immediately; resume needs fresh authorization', async () => {
    const f = fixture(['input']);
    const s = await f.create();
    s.takeOver('human-1');
    expect(() => s.takeOver('human-2')).toThrow();
    expect(code(await s.handle(req({ type: 'invokeElement', element: { id: 'btn' }, action: 'click' })))).toBe('suspended_by_takeover');
    expect(code(await s.handle(req({ type: 'accessibilitySnapshot' }, 'r2')))).toBe('ok');
    expect(await s.resume(async () => false)).toBe(false);
    expect(s.takeoverOwner).toBe('human-1');
    expect(await s.resume(async () => true)).toBe(true);
    expect(code(await s.handle(req({ type: 'invokeElement', element: { id: 'btn' }, action: 'click' }, 'r3')))).toBe('ok');
    expect(f.state.clicks).toBe(1);
  });

  it('cleans up once on stop, cancel or disconnect and leaves no usable control', async () => {
    const f = fixture(['input']);
    const s = await f.create();
    expect(code(await s.handle(req({ type: 'requestStop' })))).toBe('ok');
    await Promise.all([s.close(), s.close()]);
    expect(f.state.closed).toBe(1);
    expect(code(await s.handle(req({ type: 'invokeElement', element: { id: 'btn' }, action: 'click' }, 'r2')))).toBe('closed');
    expect(f.state.clicks).toBe(0);
    expect(() => s.takeOver('h')).toThrow();
  });

  it('records only sanitized metadata, never typed text or clipboard contents', async () => {
    const f = fixture(['input', 'clipboard']);
    const s = await f.create();
    await s.handle(req({ type: 'setElementText', element: { id: 'txt' }, text: 'hunter2' }));
    await s.handle(req({ type: 'clipboardRead' }, 'r2'));
    const serialized = JSON.stringify(f.events);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('secret');
    expect(f.events[0]).toMatchObject({ runId: 'run', attemptId: 'att', sessionId: 's1', action: 'setElementText', outcome: 'completed' });
  });

  it('maps stale accessibility elements to a typed error', async () => {
    const f = fixture(['input']);
    const s = await f.create();
    expect(code(await s.handle(req({ type: 'invokeElement', element: { id: 'gone' }, action: 'click' })))).toBe('inaccessible_widget');
  });
});
