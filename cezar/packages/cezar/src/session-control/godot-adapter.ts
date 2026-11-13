import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GraphicalSessionRequest } from '@open-mercato/cezar-contract';
import type { GraphicalAppHooks } from './graphical-adapter.ts';

export interface ChildProcessLike {
  kill(signal?: NodeJS.Signals): boolean;
  readonly exitCode: number | null;
  once(event: 'exit', listener: (code: number | null) => void): unknown;
}

export interface GodotAdapterConfig {
  /** Project-local configuration: the Godot binary (the .NET build for C# projects) and project dir. */
  godotBinary: string;
  projectPath: string;
  /** .NET and non-.NET builds share the contract; this only selects nothing but is recorded for evidence. */
  dotnet?: boolean;
  spawn(binary: string, args: string[]): ChildProcessLike;
  pollMs?: number;
  /** Frames to render before Godot quits itself. */
  frames?: number;
}

export interface GodotHandle { child: ChildProcessLike; framesDir: string }

const DRIVER = { software: 'opengl3', opengl: 'opengl3', vulkan: 'vulkan' } as const;

/** Builds the argv for a rendered Godot run. `--headless` disables rendering, so it is rejected. */
export function godotRenderedArgs(config: GodotAdapterConfig, request: GraphicalSessionRequest, framesDir: string): string[] {
  if (request.mode === 'headless' || !request.renderer) throw new Error('rendered mode required; Godot --headless cannot satisfy it');
  const args = [
    '--path', config.projectPath,
    '--rendering-driver', DRIVER[request.renderer.requirement],
    '--write-movie', join(framesDir, 'frame.png'),
    '--quit-after', String(config.frames ?? 5),
    request.appEntryPoint,
  ];
  if (args.includes('--headless')) throw new Error('--headless is not allowed for rendered sessions');
  return args;
}

export function createGodotAdapter(config: GodotAdapterConfig): GraphicalAppHooks<GodotHandle> {
  const pollMs = config.pollMs ?? 100;
  const firstFrame = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.png')).sort()[0];
  return {
    async launch(request) {
      const framesDir = await mkdtemp(join(tmpdir(), 'godot-frames-'));
      try {
        return { child: config.spawn(config.godotBinary, godotRenderedArgs(config, request, framesDir)), framesDir };
      } catch (error) {
        await rm(framesDir, { recursive: true, force: true });
        throw error;
      }
    },
    async ready(handle, signal) {
      while (!signal.aborted) {
        if (await firstFrame(handle.framesDir)) return true;
        if (handle.child.exitCode !== null) return false;
        await new Promise((r) => setTimeout(r, pollMs));
      }
      return false;
    },
    async captureFrame(handle) {
      const name = await firstFrame(handle.framesDir);
      if (!name) throw new Error('no frame');
      await access(join(handle.framesDir, name));
      return new Uint8Array(await readFile(join(handle.framesDir, name)));
    },
    async quit(handle) {
      try {
        if (handle.child.exitCode === null) {
          const exited = new Promise<void>((resolve) => handle.child.once('exit', () => resolve()));
          handle.child.kill('SIGKILL');
          await exited;
        }
      } finally {
        await rm(handle.framesDir, { recursive: true, force: true });
      }
    },
  };
}
