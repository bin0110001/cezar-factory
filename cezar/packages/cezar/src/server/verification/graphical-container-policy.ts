import { z } from 'zod';
import type { GraphicalSessionRequest } from '@open-mercato/cezar-contract';

/**
 * Rootless Podman isolation policy for graphical worker sessions (#340).
 * Deny by default: every grant (device, live desktop, input, network) must be
 * named by the worker policy, and the argv builder cannot emit anything the
 * argv auditor would reject. Pure functions: no process is started here.
 */

export const graphicalContainerPolicySchema = z.object({
  image: z.string().min(1).max(512).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/),
  limits: z.object({
    cpus: z.number().positive().max(64),
    memoryMib: z.number().int().min(64).max(262_144),
    diskMib: z.number().int().min(16).max(1_048_576),
    pids: z.number().int().min(16).max(8_192).default(512),
    gpuMemoryMib: z.number().int().min(0).max(262_144).default(0),
    maxSessionsPerWorker: z.number().int().min(1).max(16),
    maxFps: z.number().int().min(1).max(240),
    maxWidth: z.number().int().min(320).max(16_384),
    maxHeight: z.number().int().min(240).max(16_384),
    maxVideoSeconds: z.number().int().min(0).max(3_600),
    maxSessionMs: z.number().int().min(100).max(3_600_000),
    maxImageBytes: z.number().int().min(0).max(64 * 1024 * 1024).default(8 * 1024 * 1024),
  }).strict(),
  /** Host capacity and the share always kept free for ordinary coding jobs (#198 fairness). */
  host: z.object({
    cpus: z.number().positive(),
    memoryMib: z.number().int().positive(),
    codingReserveCpus: z.number().min(0),
    codingReserveMemoryMib: z.number().int().min(0),
  }).strict(),
  /** Exact render-node devices this worker may hand to a session. Never `/dev`. */
  allowedDevices: z.array(z.string().regex(/^\/dev\/dri\/renderD\d+$/)).max(8).default([]),
  /** none = no network; loopback = session-private loopback only. Host network is not expressible. */
  network: z.enum(['none', 'loopback']).default('none'),
  /** Live desktop and input are off unless the worker policy opts in (#329 grants). */
  liveDesktop: z.boolean().default(false),
  inputGrant: z.boolean().default(false),
  capture: z.enum(['none', 'view-only']).default('view-only'),
}).strict();
export type GraphicalContainerPolicy = z.infer<typeof graphicalContainerPolicySchema>;

export interface GraphicalSessionAsk {
  sessionId: string;
  request: GraphicalSessionRequest;
  device?: string;
  fps?: number;
  videoSeconds?: number;
  wantsLiveDesktop?: boolean;
  wantsInput?: boolean;
  cpus?: number;
  memoryMib?: number;
}

export type PolicyDenialReason =
  | 'invalid_session_id' | 'unauthorized_device' | 'live_desktop_denied' | 'input_denied'
  | 'resolution_exceeds_limit' | 'fps_exceeds_limit' | 'video_exceeds_limit' | 'timeout_exceeds_limit'
  | 'duplicate_session' | 'session_limit' | 'resource_exhausted' | 'coding_reserve' | 'capture_denied'
  | 'forbidden_argv';

export class GraphicalPolicyError extends Error {
  constructor(readonly reason: PolicyDenialReason, message: string) {
    super(message);
    this.name = 'GraphicalPolicyError';
  }
}

const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** Env keys a session may receive. Anything else, and anything token-shaped, is refused. */
const ALLOWED_ENV_KEYS = new Set(['CEZAR_SESSION_ID', 'CEZAR_SESSION_MODE', 'SDL_VIDEODRIVER', 'WAYLAND_DISPLAY', 'DISPLAY', 'XDG_RUNTIME_DIR', 'LANG']);

/** Maps limit breaches onto the existing typed failure reason in the session contract. */
export function breachFailureReason(reason: PolicyDenialReason): 'resource_exhausted' | 'gpu_unavailable' | 'display_collision' | undefined {
  switch (reason) {
    case 'resource_exhausted': case 'coding_reserve': case 'session_limit': case 'resolution_exceeds_limit':
    case 'fps_exceeds_limit': case 'video_exceeds_limit': case 'timeout_exceeds_limit':
      return 'resource_exhausted';
    case 'unauthorized_device': return 'gpu_unavailable';
    case 'duplicate_session': return 'display_collision';
    default: return undefined;
  }
}

/** Validates a session ask against the worker policy. Throws GraphicalPolicyError on denial. */
export function checkSessionAgainstPolicy(policy: GraphicalContainerPolicy, ask: GraphicalSessionAsk): void {
  const { limits } = policy;
  if (!SESSION_ID.test(ask.sessionId)) throw new GraphicalPolicyError('invalid_session_id', 'session id must be a short slug');
  if (ask.device !== undefined && !policy.allowedDevices.includes(ask.device)) {
    throw new GraphicalPolicyError('unauthorized_device', 'device is not on the worker allowlist');
  }
  if (ask.request.renderer?.gpuRequired && policy.allowedDevices.length === 0) {
    throw new GraphicalPolicyError('unauthorized_device', 'GPU required but the worker grants no device');
  }
  if (ask.wantsLiveDesktop && !policy.liveDesktop) throw new GraphicalPolicyError('live_desktop_denied', 'live desktop access is off');
  if (ask.wantsInput && !(policy.inputGrant && policy.liveDesktop)) throw new GraphicalPolicyError('input_denied', 'input requires an explicit grant');
  if (ask.request.permittedEvidence.some((kind) => kind === 'screenshot' || kind === 'video') && policy.capture === 'none') {
    throw new GraphicalPolicyError('capture_denied', 'capture is not permitted by the worker policy');
  }
  const display = ask.request.display;
  if (display && (display.width > limits.maxWidth || display.height > limits.maxHeight)) {
    throw new GraphicalPolicyError('resolution_exceeds_limit', 'resolution exceeds the worker limit');
  }
  if ((ask.fps ?? 0) > limits.maxFps) throw new GraphicalPolicyError('fps_exceeds_limit', 'fps exceeds the worker limit');
  if ((ask.videoSeconds ?? 0) > limits.maxVideoSeconds) throw new GraphicalPolicyError('video_exceeds_limit', 'video duration exceeds the worker limit');
  if (ask.request.timeoutMs > limits.maxSessionMs) throw new GraphicalPolicyError('timeout_exceeds_limit', 'session time exceeds the worker limit');
}

/** In-memory admission ledger: sessions per worker and the coding-capacity reserve. */
export class GraphicalSessionLedger {
  private readonly active = new Map<string, { cpus: number; memoryMib: number }>();
  constructor(private readonly policy: GraphicalContainerPolicy) {}

  get activeCount(): number { return this.active.size; }

  admit(ask: GraphicalSessionAsk): void {
    checkSessionAgainstPolicy(this.policy, ask);
    const { limits, host } = this.policy;
    if (this.active.has(ask.sessionId)) throw new GraphicalPolicyError('duplicate_session', 'session id already active');
    if (this.active.size >= limits.maxSessionsPerWorker) throw new GraphicalPolicyError('session_limit', 'worker session limit reached');
    const cpus = Math.min(ask.cpus ?? limits.cpus, limits.cpus);
    const memoryMib = Math.min(ask.memoryMib ?? limits.memoryMib, limits.memoryMib);
    if ((ask.cpus ?? 0) > limits.cpus || (ask.memoryMib ?? 0) > limits.memoryMib) {
      throw new GraphicalPolicyError('resource_exhausted', 'requested resources exceed the per-session limit');
    }
    let usedCpus = cpus; let usedMem = memoryMib;
    for (const s of this.active.values()) { usedCpus += s.cpus; usedMem += s.memoryMib; }
    if (usedCpus > host.cpus - host.codingReserveCpus || usedMem > host.memoryMib - host.codingReserveMemoryMib) {
      throw new GraphicalPolicyError('coding_reserve', 'admission would starve the coding reserve');
    }
    this.active.set(ask.sessionId, { cpus, memoryMib });
  }

  /** Release on completion, cancellation, or failure; idempotent so cleanup can always run. */
  release(sessionId: string): boolean { return this.active.delete(sessionId); }
}

export interface SessionUsage { elapsedMs: number; memoryMib: number; diskMib: number; fps: number; videoSeconds: number }

/** Runtime enforcement: returns the breached limit or undefined. The caller kills and cleans up. */
export function enforceRuntimeLimits(policy: GraphicalContainerPolicy, usage: SessionUsage): PolicyDenialReason | undefined {
  const { limits } = policy;
  if (usage.elapsedMs > limits.maxSessionMs) return 'timeout_exceeds_limit';
  if (usage.memoryMib > limits.memoryMib || usage.diskMib > limits.diskMib) return 'resource_exhausted';
  if (usage.fps > limits.maxFps) return 'fps_exceeds_limit';
  if (usage.videoSeconds > limits.maxVideoSeconds) return 'video_exceeds_limit';
  return undefined;
}

const TOKEN_VALUE = /(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/;
const SECRET_KEY = /(?:token|secret|passw(?:or)?d|credential|api[_-]?key|auth)/i;

export interface BuiltContainerCommand { command: 'podman'; argv: string[] }

/** Builds the `podman run` argv. Everything is least-privilege and re-audited before returning. */
export function buildContainerArgv(
  policy: GraphicalContainerPolicy,
  ask: GraphicalSessionAsk,
  env: Record<string, string> = {},
): BuiltContainerCommand {
  checkSessionAgainstPolicy(policy, ask);
  const { limits } = policy;
  const argv = [
    'run', '--rm', '--name', `cezar-gfx-${ask.sessionId}`,
    '--cap-drop=all', '--security-opt=no-new-privileges', '--read-only',
    '--userns=keep-id', '--ipc=private', '--pid=private',
    `--network=${policy.network === 'none' ? 'none' : 'slirp4netns:allow_host_loopback=false'}`,
    `--cpus=${limits.cpus}`, `--memory=${limits.memoryMib}m`, `--memory-swap=${limits.memoryMib}m`,
    `--pids-limit=${limits.pids}`,
    `--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=${limits.diskMib}m`,
    `--stop-timeout=5`,
  ];
  if (ask.device) argv.push(`--device=${ask.device}`);
  for (const [key, value] of Object.entries({ CEZAR_SESSION_ID: ask.sessionId, CEZAR_SESSION_MODE: ask.request.mode, ...env })) {
    if (!ALLOWED_ENV_KEYS.has(key) || SECRET_KEY.test(key) || TOKEN_VALUE.test(value) || /[\r\n\0]/.test(value)) {
      throw new GraphicalPolicyError('forbidden_argv', `environment entry ${key} is not permitted in a session container`);
    }
    argv.push('--env', `${key}=${value}`);
  }
  argv.push(policy.image);
  assertSafeContainerArgv(argv, policy);
  return { command: 'podman', argv };
}

const FORBIDDEN_FLAGS = /^--(?:privileged|cap-add|device-cgroup-rule|env-host|env-file|security-opt=(?:seccomp|label|apparmor)=?(?:unconfined|disable).*|pid=host|ipc=host|uts=host|userns=host|network=host|net=host|cgroupns=host|group-add|add-host)(?:=.*)?$/;
const FORBIDDEN_PATHS = /(?:\/\.X11-unix|\/tmp\/\.X11|\.Xauthority|\/run\/user|\/var\/run|\/run\/|\/run$|dbus|wayland-\d|podman\.sock|docker\.sock|containerd|\/proc|\/sys|\/etc\/shadow|\/home|\/root)/i;

/** Independent auditor. Also run by tests against hand-built argv to prove forbidden grants are rejected. */
export function assertSafeContainerArgv(argv: readonly string[], policy?: Pick<GraphicalContainerPolicy, 'allowedDevices'>): void {
  const deny = (why: string): never => { throw new GraphicalPolicyError('forbidden_argv', why); };
  const flat: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    // Normalise `--flag value` to `--flag=value` for the flags we audit.
    if (/^--(?:device|volume|mount|security-opt|network|net|pid|ipc|userns|env|cap-add|group-add|add-host|user)$/.test(arg) || arg === '-v' || arg === '-e' || arg === '--tmpfs') {
      flat.push(`${arg === '-v' ? '--volume' : arg === '-e' ? '--env' : arg}=${argv[i + 1] ?? ''}`); i += 1;
    } else flat.push(arg);
  }
  for (const arg of flat) {
    if (FORBIDDEN_FLAGS.test(arg)) deny(`forbidden grant: ${arg.split('=')[0]}`);
    if (arg.startsWith('--device=')) {
      const dev = arg.slice('--device='.length).split(':')[0]!;
      if (!/^\/dev\/dri\/renderD\d+$/.test(dev) || !policy || !policy.allowedDevices.includes(dev)) deny('device grant is not an allowlisted render node');
    }
    if (arg.startsWith('--volume=') || arg.startsWith('--mount=')) deny('host mounts are not permitted');
    if (arg.startsWith('--tmpfs=') && FORBIDDEN_PATHS.test(arg)) deny('tmpfs targets a forbidden path');
    if (arg.startsWith('--env=')) {
      const body = arg.slice('--env='.length);
      const key = body.split('=')[0]!;
      if (SECRET_KEY.test(key) || TOKEN_VALUE.test(body)) deny('credential-like environment entry in argv');
    }
    if (arg === '-v' || arg === '--volumes-from') deny('host mounts are not permitted');
    if (TOKEN_VALUE.test(arg)) deny('token-shaped value in argv');
  }
  if (!flat.includes('--cap-drop=all')) deny('capabilities must be dropped');
  if (!flat.includes('--security-opt=no-new-privileges')) deny('no-new-privileges is required');
  if (!flat.some((a) => /^--network=(?:none|slirp4netns:allow_host_loopback=false)$/.test(a))) deny('network must be none or session-private');
  for (const key of ['--cpus=', '--memory=', '--pids-limit=']) {
    if (!flat.some((a) => a.startsWith(key))) deny(`resource limit ${key} is required`);
  }
}

// ---- Redaction -----------------------------------------------------------

const PATH_RE = /(?:\/(?:home|Users|root|run\/user|mnt|projects)\/[^\s'"`:;,)]*|[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\s'"`:;,)]*)/g;
const KV_SECRET_RE = /\b([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|api[_-]?key|authorization)[A-Za-z0-9_.-]*)\s*([=:])\s*("[^"]*"|'[^']*'|\S+)/gi;
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const CLIPBOARD_RE = /(clipboard[^\n:=]*[:=]\s*)([^\n]*)/gi;

export const REDACTED = '[redacted]';

/** Redacts tokens, credentials, clipboard text and host paths from a diagnostic string. */
export function redactDiagnostics(text: string, maxLength = 8_192): string {
  let out = text
    .replace(CLIPBOARD_RE, (_m, prefix: string) => `${prefix}[clipboard redacted]`)
    .replace(BEARER_RE, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(KV_SECRET_RE, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`)
    .replace(new RegExp(TOKEN_VALUE.source, 'g'), REDACTED)
    .replace(PATH_RE, '[path]');
  if (out.length > maxLength) out = `${out.slice(0, maxLength)}…[truncated ${out.length - maxLength} chars]`;
  return out;
}

/** Clipboard content never leaves the session: only its size is reported. */
export function redactClipboard(content: string | Uint8Array): { redacted: true; bytes: number } {
  return { redacted: true, bytes: typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength };
}

export interface ImageEvidence { name: string; bytes: number; sensitive?: boolean }

/** Drops sensitive or oversized imagery at the collection boundary, keeping only bounded metadata. */
export function boundImageEvidence(
  policy: Pick<GraphicalContainerPolicy, 'limits'>,
  images: readonly ImageEvidence[],
): { kept: string[]; dropped: Array<{ name: string; reason: 'sensitive' | 'too_large' }> } {
  const kept: string[] = []; const dropped: Array<{ name: string; reason: 'sensitive' | 'too_large' }> = [];
  let total = 0;
  for (const image of images) {
    const name = redactDiagnostics(image.name, 128);
    if (image.sensitive) { dropped.push({ name, reason: 'sensitive' }); continue; }
    if (image.bytes > policy.limits.maxImageBytes || total + image.bytes > policy.limits.maxImageBytes * 4) {
      dropped.push({ name, reason: 'too_large' }); continue;
    }
    total += image.bytes; kept.push(name);
  }
  return { kept, dropped };
}
