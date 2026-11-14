import { describe, expect, it } from 'vitest';
import { graphicalSessionRequestSchema } from '@open-mercato/cezar-contract';
import {
  GraphicalPolicyError, GraphicalSessionLedger, assertSafeContainerArgv, boundImageEvidence, breachFailureReason,
  buildContainerArgv, enforceRuntimeLimits, graphicalContainerPolicySchema, redactClipboard, redactDiagnostics,
  type GraphicalContainerPolicy,
} from './graphical-container-policy';

const policy: GraphicalContainerPolicy = graphicalContainerPolicySchema.parse({
  image: 'localhost/cezar-gfx:1',
  limits: { cpus: 2, memoryMib: 2048, diskMib: 512, maxSessionsPerWorker: 2, maxFps: 60, maxWidth: 1920, maxHeight: 1080, maxVideoSeconds: 30, maxSessionMs: 120_000 },
  host: { cpus: 8, memoryMib: 16_384, codingReserveCpus: 4, codingReserveMemoryMib: 8_192 },
  allowedDevices: ['/dev/dri/renderD128'],
});
const request = (over: Record<string, unknown> = {}) => graphicalSessionRequestSchema.parse({
  schemaVersion: 1, mode: 'displayed', appEntryPoint: 'game/main.tscn', timeoutMs: 60_000,
  display: { backend: 'x11', width: 1280, height: 720, dpi: 96 }, renderer: { requirement: 'opengl' }, ...over,
});
const ask = (over: Record<string, unknown> = {}) => ({ sessionId: 's1', request: request(), ...over });
const reason = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as GraphicalPolicyError).reason; } return undefined; };

describe('container argv', () => {
  it('is rootless least-privilege with limits and no forbidden grants', () => {
    const { command, argv } = buildContainerArgv(policy, ask({ device: '/dev/dri/renderD128' }));
    const text = argv.join(' ');
    expect(command).toBe('podman');
    for (const bad of ['--privileged', '--cap-add', '--network=host', '--pid=host', '--volume', '--mount', '-v ', '.X11-unix', 'dbus', 'podman.sock', '--device=/dev ', 'seccomp=unconfined']) {
      expect(text).not.toContain(bad);
    }
    expect(argv).toEqual(expect.arrayContaining(['--cap-drop=all', '--security-opt=no-new-privileges', '--read-only', '--network=none', '--cpus=2', '--memory=2048m', '--pids-limit=512']));
    expect(argv).toContain('--device=/dev/dri/renderD128');
    expect(argv.filter((a) => a.startsWith('--device'))).toHaveLength(1);
  });

  it('rejects hand-built forbidden grants', () => {
    const { argv } = buildContainerArgv(policy, ask());
    const bad: string[][] = [
      ['--privileged'], ['--device=/dev'], ['--device', '/dev/dri/card0'], ['--device=/dev/dri/renderD129'],
      ['-v', '/tmp/.X11-unix:/tmp/.X11-unix'], ['--volume=/run/user/1000/bus:/bus'], ['--mount', 'type=bind,src=/run/podman/podman.sock,dst=/s'],
      ['--network=host'], ['--pid=host'], ['--ipc=host'], ['--cap-add=SYS_ADMIN'], ['--security-opt=seccomp=unconfined'],
      ['--env', 'GITHUB_TOKEN=abc'], ['-e', 'X=ghp_abcdefghijklmnopqrstuvwx'], ['--env-host'],
    ];
    for (const extra of bad) {
      expect(reason(() => assertSafeContainerArgv([...argv.slice(0, -1), ...extra, argv.at(-1)!], policy)), extra.join(' ')).toBe('forbidden_argv');
    }
    expect(reason(() => assertSafeContainerArgv(['run', 'img'], policy))).toBe('forbidden_argv');
  });

  it('refuses secrets in the environment', () => {
    expect(reason(() => buildContainerArgv(policy, ask(), { GITHUB_TOKEN: 'x' }))).toBe('forbidden_argv');
    expect(reason(() => buildContainerArgv(policy, ask(), { LANG: 'ghp_abcdefghijklmnopqrstuvwx' }))).toBe('forbidden_argv');
    expect(reason(() => buildContainerArgv(policy, ask(), { HOME: '/home/me' }))).toBe('forbidden_argv');
  });

  it('loopback network stays session-private', () => {
    const p = graphicalContainerPolicySchema.parse({ ...policy, network: 'loopback' });
    expect(buildContainerArgv(p, ask()).argv).toContain('--network=slirp4netns:allow_host_loopback=false');
  });
});

describe('policy denial', () => {
  it('denies unauthorized device, live desktop and input by default', () => {
    expect(reason(() => buildContainerArgv(policy, ask({ device: '/dev/dri/card0' })))).toBe('unauthorized_device');
    expect(reason(() => buildContainerArgv(policy, ask({ device: '/dev' })))).toBe('unauthorized_device');
    expect(reason(() => buildContainerArgv(policy, ask({ wantsLiveDesktop: true })))).toBe('live_desktop_denied');
    expect(reason(() => buildContainerArgv(policy, ask({ wantsInput: true })))).toBe('input_denied');
    const live = { ...policy, liveDesktop: true };
    expect(reason(() => buildContainerArgv(live, ask({ wantsInput: true })))).toBe('input_denied');
  });
  it('enforces resolution, fps, video and time limits', () => {
    expect(reason(() => buildContainerArgv(policy, ask({ request: request({ display: { backend: 'x11', width: 3840, height: 2160, dpi: 96 } }) })))).toBe('resolution_exceeds_limit');
    expect(reason(() => buildContainerArgv(policy, ask({ fps: 144 })))).toBe('fps_exceeds_limit');
    expect(reason(() => buildContainerArgv(policy, ask({ videoSeconds: 90 })))).toBe('video_exceeds_limit');
    expect(reason(() => buildContainerArgv(policy, ask({ request: request({ timeoutMs: 600_000 }) })))).toBe('timeout_exceeds_limit');
  });
  it('requires a granted device when the GPU is required', () => {
    const none = { ...policy, allowedDevices: [] };
    expect(reason(() => buildContainerArgv(none, ask({ request: request({ renderer: { requirement: 'vulkan', gpuRequired: true } }) })))).toBe('unauthorized_device');
  });
  it('maps breaches onto typed session failure reasons', () => {
    expect(breachFailureReason('coding_reserve')).toBe('resource_exhausted');
    expect(breachFailureReason('duplicate_session')).toBe('display_collision');
    expect(breachFailureReason('forbidden_argv')).toBeUndefined();
  });
});

describe('admission and runtime enforcement', () => {
  it('limits sessions, rejects duplicates, protects the coding reserve, and cleans up on release', () => {
    const ledger = new GraphicalSessionLedger(policy);
    ledger.admit(ask({ sessionId: 'a' }));
    expect(reason(() => ledger.admit(ask({ sessionId: 'a' })))).toBe('duplicate_session');
    ledger.admit(ask({ sessionId: 'b' }));
    expect(reason(() => ledger.admit(ask({ sessionId: 'c' })))).toBe('session_limit');
    expect(ledger.release('a')).toBe(true);
    expect(ledger.release('a')).toBe(false);
    ledger.admit(ask({ sessionId: 'c' }));
    expect(ledger.activeCount).toBe(2);

    const tight = new GraphicalSessionLedger({ ...policy, host: { ...policy.host, codingReserveCpus: 7 } });
    expect(reason(() => tight.admit(ask()))).toBe('coding_reserve');
    expect(tight.activeCount).toBe(0);
    expect(reason(() => new GraphicalSessionLedger(policy).admit(ask({ cpus: 4 })))).toBe('resource_exhausted');
  });
  it('detects runtime breaches', () => {
    const ok = { elapsedMs: 1, memoryMib: 1, diskMib: 1, fps: 30, videoSeconds: 1 };
    expect(enforceRuntimeLimits(policy, ok)).toBeUndefined();
    expect(enforceRuntimeLimits(policy, { ...ok, elapsedMs: 200_000 })).toBe('timeout_exceeds_limit');
    expect(enforceRuntimeLimits(policy, { ...ok, memoryMib: 4096 })).toBe('resource_exhausted');
    expect(enforceRuntimeLimits(policy, { ...ok, diskMib: 1024 })).toBe('resource_exhausted');
    expect(enforceRuntimeLimits(policy, { ...ok, fps: 120 })).toBe('fps_exceeds_limit');
    expect(enforceRuntimeLimits(policy, { ...ok, videoSeconds: 31 })).toBe('video_exceeds_limit');
  });
});

describe('redaction', () => {
  it('removes tokens, credentials, clipboard text and host paths', () => {
    const out = redactDiagnostics('saved /home/alice/proj/a.png GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwx Authorization: Bearer abcdefgh12345678 sk-abcdefghijklmnopqrstu\nclipboard: my secret note');
    expect(out).not.toMatch(/ghp_|abcdefgh12345678|secret note|alice|sk-abc/);
    expect(out).toContain('[path]');
  });
  it('bounds length and clipboard to a size only', () => {
    expect(redactDiagnostics('x'.repeat(100), 10)).toContain('truncated 90');
    expect(redactClipboard('hello')).toEqual({ redacted: true, bytes: 5 });
  });
  it('drops sensitive or oversized imagery', () => {
    const r = boundImageEvidence(policy, [{ name: 'a.png', bytes: 10 }, { name: 'pw.png', bytes: 10, sensitive: true }, { name: 'big.png', bytes: 9 * 1024 * 1024 }]);
    expect(r.kept).toEqual(['a.png']);
    expect(r.dropped.map((d) => d.reason)).toEqual(['sensitive', 'too_large']);
  });
});
