/** Real Linux SessionHost: upstream Xvfb, xdpyinfo/glxinfo and ImageMagick/xwd for capture (#339). */
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SessionHost, SessionProcess } from './graphical-session.ts';

const execFileAsync = promisify(execFile);

export const linuxSessionHost: SessionHost = {
  makeTempDir: (prefix) => mkdtemp(join(tmpdir(), prefix)),
  removeDir: (path) => rm(path, { recursive: true, force: true }),
  async spawn(command, args, env, cwd): Promise<SessionProcess> {
    // detached => own process group, so killTree can signal the whole tree.
    const child = nodeSpawn(command, args, { env: { ...process.env, ...env }, cwd, detached: true, stdio: 'ignore' });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.once('error', () => resolve({ code: null, signal: 'spawn-error' }));
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    let done = false;
    void exited.then(() => { done = true; });
    return {
      pid: child.pid ?? -1,
      exited,
      async killTree() {
        if (done || !child.pid) return;
        for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
          try { process.kill(-child.pid, sig); } catch { return; }
          const r = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 1_000))]);
          if (r) return;
        }
        throw new Error(`process group ${child.pid} survived SIGKILL`);
      },
    };
  },
  async displayReady(display) {
    try { await execFileAsync('xdpyinfo', ['-display', display], { timeout: 2_000 }); return true; } catch { return false; }
  },
  async capture(display, path) {
    await execFileAsync('import', ['-display', display, '-window', 'root', path], { timeout: 10_000 });
    return (await stat(path)).size;
  },
  async fingerprint(display) {
    const { stdout } = await execFileAsync('glxinfo', ['-display', display, '-B'], {
      timeout: 10_000, env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1' },
    });
    return stdout.match(/OpenGL renderer string:\s*(.+)/i)?.[1]?.trim() ?? '';
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};
