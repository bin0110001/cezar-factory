import { writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { graphicalSessionRequestSchema, graphicalSessionOutcomeSchema } from '@open-mercato/cezar-contract';
import { runGraphicalSession, type GraphicalAppHooks } from './graphical-adapter.ts';
import { createGodotAdapter, godotRenderedArgs } from './godot-adapter.ts';

const request = (over: object = {}) => graphicalSessionRequestSchema.parse({
  schemaVersion: 1, mode: 'offscreen-rendered', renderer: { requirement: 'software' }, appEntryPoint: 'main.tscn', timeoutMs: 500, ...over,
});

function fakeChild() {
  const ev = new EventEmitter();
  const child = {
    exitCode: null as number | null,
    kill: vi.fn(() => { child.exitCode = 0; ev.emit('exit', 0); return true; }),
    once: (e: 'exit', l: (c: number | null) => void) => ev.once(e, l),
  };
  return child;
}

const generic = (over: Partial<GraphicalAppHooks<string>> = {}): GraphicalAppHooks<string> => ({
  launch: async () => 'h', ready: async () => true, captureFrame: async () => new Uint8Array([1, 2, 3]), quit: vi.fn(async () => undefined), ...over,
});

describe('generic graphical hook runner', () => {
  it('captures a frame via generic hooks (non-Godot fixture)', async () => {
    const hooks = generic();
    const r = await runGraphicalSession(request(), hooks, { sessionId: 's' });
    expect(r.outcome.status).toBe('completed');
    expect(r.frame?.bytes).toBe(3);
    expect(r.renderedCriterionSatisfied).toBe(true);
    expect(hooks.quit).toHaveBeenCalledOnce();
    expect(graphicalSessionOutcomeSchema.safeParse(r.outcome).success).toBe(true);
  });
  it('headless can never satisfy a rendered criterion', async () => {
    const r = await runGraphicalSession(request({ mode: 'headless', renderer: undefined }), generic(), { sessionId: 's' });
    expect(r.outcome.status).toBe('failed');
    expect(r.renderedCriterionSatisfied).toBe(false);
  });
  it('launch failure, readiness failure, crash and empty frame are not success', async () => {
    for (const hooks of [
      generic({ launch: async () => { throw new Error('x'); } }),
      generic({ ready: async () => false }),
      generic({ ready: async () => { throw new Error('crash'); } }),
      generic({ captureFrame: async () => new Uint8Array() }),
    ]) {
      const r = await runGraphicalSession(request(), hooks, { sessionId: 's' });
      expect(r.outcome.status).toBe('failed');
      expect(r.renderedCriterionSatisfied).toBe(false);
      expect(graphicalSessionOutcomeSchema.safeParse(r.outcome).success).toBe(true);
    }
  });
  it('times out a hung app and still quits', async () => {
    const hooks = generic({ ready: () => new Promise<boolean>(() => undefined) });
    const r = await runGraphicalSession(request({ timeoutMs: 100 }), hooks, { sessionId: 's' });
    expect(r.outcome.reason).toBe('hung_application');
    expect(hooks.quit).toHaveBeenCalledOnce();
  });
  it('cancel yields cancelled and cleans up', async () => {
    const ac = new AbortController();
    const hooks = generic({ ready: () => new Promise<boolean>(() => undefined) });
    const p = runGraphicalSession(request(), hooks, { sessionId: 's', signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    const r = await p;
    expect(r.outcome).toMatchObject({ status: 'cancelled', reason: 'cancelled' });
    expect(hooks.quit).toHaveBeenCalledOnce();
  });
  it('cleanup failure downgrades success to orphaned_child', async () => {
    const r = await runGraphicalSession(request(), generic({ quit: async () => { throw new Error('stuck'); } }), { sessionId: 's' });
    expect(r.outcome).toMatchObject({ status: 'failed', reason: 'orphaned_child' });
    expect(r.renderedCriterionSatisfied).toBe(false);
  });
});

describe('Godot adapter (.NET and non-.NET share one contract)', () => {
  for (const dotnet of [false, true]) {
    it(`rendered scene yields a captured frame (dotnet=${dotnet})`, async () => {
      const child = fakeChild();
      let argv: string[] = [];
      const hooks = createGodotAdapter({
        godotBinary: dotnet ? 'godot-mono' : 'godot', projectPath: '/proj', dotnet, pollMs: 5,
        spawn: (_b, args) => { argv = args; void writeFile(args[args.indexOf('--write-movie') + 1]!.replace('frame.png', 'frame00000001.png'), Buffer.from('png-bytes')); return child; },
      });
      const r = await runGraphicalSession(request(), hooks, { sessionId: 'g' });
      expect(r.outcome.status).toBe('completed');
      expect(r.frame?.bytes).toBe(9);
      expect(argv).not.toContain('--headless');
      expect(child.kill).toHaveBeenCalled();
    });
  }
  it('rejects headless argv and exits-without-frame is a failure', async () => {
    const cfg = { godotBinary: 'godot', projectPath: '/p', spawn: () => fakeChild() };
    expect(() => godotRenderedArgs(cfg, request({ mode: 'headless', renderer: undefined }), '/t')).toThrow();
    const crashed = fakeChild(); crashed.exitCode = 1;
    const r = await runGraphicalSession(request(), createGodotAdapter({ ...cfg, spawn: () => crashed, pollMs: 5 }), { sessionId: 'g' });
    expect(r.outcome.status).toBe('failed');
  });
});
