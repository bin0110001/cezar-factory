import { z } from 'zod';
import { REDACTED, SECRET_NAME_RE, collectSecretValues, redactDeep, redactSecrets } from '../../core/secret-redaction.js';

/**
 * Isolated scanner worker execution profile (#605). A scan runs unprivileged
 * with read-only source/artifact mounts, an allowlist-only environment and no
 * network except the advisory DB update phase. Pure functions: nothing is
 * started here. Anything that cannot be enforced fails closed with a reason.
 */

const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i;

export const scannerWorkerProfileSchema = z.object({
  image: z.string().min(1).max(512).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/),
  resources: z.object({
    cpus: z.number().positive().max(16).default(2),
    memoryMib: z.number().int().min(64).max(32_768).default(2048),
    pids: z.number().int().min(16).max(4096).default(256),
    timeoutMs: z.number().int().min(1000).max(3_600_000).default(600_000),
  }).strict().default(() => ({ cpus: 2, memoryMib: 2048, pids: 256, timeoutMs: 600_000 })),
  /** Container-side targets; both are mounted read-only, never writable. */
  mounts: z.object({
    source: z.string().min(1),
    artifacts: z.string().min(1).optional(),
  }).strict(),
  /** Env names the scanner may see. Secret-shaped names are refused even if listed. */
  envAllowlist: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).max(32).default(['PATH', 'LANG', 'TZ', 'TMPDIR']),
  /** Egress is denied during `scan`; only `db-update` may reach these hosts. */
  advisoryDbHosts: z.array(z.string().regex(HOST)).max(8).default([]),
}).strict();
export type ScannerWorkerProfile = z.infer<typeof scannerWorkerProfileSchema>;

export type ScannerPhase = 'db-update' | 'scan';

export type ScannerDenialReason =
  | 'secret_env_allowlisted' | 'writable_mount' | 'unsupported_platform' | 'no_container_runtime'
  | 'egress_outside_db_update' | 'unknown_egress_host' | 'forbidden_argv';

export class ScannerProfileError extends Error {
  constructor(readonly reason: ScannerDenialReason, message: string) {
    super(message);
    this.name = 'ScannerProfileError';
  }
}

/** Allowlist-only env: unlisted names are dropped; a secret-named allowlist entry is a config error. */
export function scrubScannerEnv(profile: ScannerWorkerProfile, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const bad = profile.envAllowlist.find((k) => SECRET_NAME_RE.test(k));
  if (bad) throw new ScannerProfileError('secret_env_allowlisted', `env allowlist entry ${bad} looks like a credential`);
  const out: Record<string, string> = {};
  for (const key of profile.envAllowlist) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export interface ScannerEnforcement { mode: 'container'; command: string }

/** Linux/macOS need rootless Podman; Windows has no equivalent mount/egress primitive, so it fails closed. */
export function planScannerEnforcement(platform: NodeJS.Platform, runtimes: { podman?: boolean }): ScannerEnforcement {
  if (platform === 'win32') throw new ScannerProfileError('unsupported_platform', 'scanner isolation (read-only mounts, egress policy) cannot be enforced on Windows; run on a Linux worker');
  if (!runtimes.podman) throw new ScannerProfileError('no_container_runtime', 'rootless podman is required to enforce scanner isolation');
  return { mode: 'container', command: 'podman' };
}

export interface ScannerRunInput { phase: ScannerPhase; sourceHostPath: string; artifactsHostPath?: string; command: string[]; egressHosts?: string[] }

/** Build the container argv. Network is `none` except during db-update, which names allowlisted hosts only. */
export function buildScannerArgv(profile: ScannerWorkerProfile, input: ScannerRunInput, env: NodeJS.ProcessEnv = process.env): { command: string; argv: string[] } {
  const r = profile.resources;
  const scrubbed = scrubScannerEnv(profile, env);
  const hosts = input.egressHosts ?? [];
  if (input.phase === 'scan' && hosts.length) throw new ScannerProfileError('egress_outside_db_update', 'egress is only permitted during the advisory DB update phase');
  if (input.phase === 'db-update') {
    const unknown = hosts.find((h) => !profile.advisoryDbHosts.includes(h));
    if (unknown || !hosts.length) throw new ScannerProfileError('unknown_egress_host', `db-update egress must name allowlisted hosts (${unknown ?? 'none given'})`);
  }
  const argv = [
    'run', '--rm', '--cap-drop=all', '--security-opt=no-new-privileges', '--read-only', '--user=65534:65534',
    input.phase === 'db-update' ? '--network=slirp4netns:allow_host_loopback=false' : '--network=none',
    `--cpus=${r.cpus}`, `--memory=${r.memoryMib}m`, `--pids-limit=${r.pids}`,
    `--mount=type=bind,src=${input.sourceHostPath},dst=${profile.mounts.source},ro=true`,
  ];
  if (input.artifactsHostPath && profile.mounts.artifacts) argv.push(`--mount=type=bind,src=${input.artifactsHostPath},dst=${profile.mounts.artifacts},ro=true`);
  for (const [k, v] of Object.entries(scrubbed)) argv.push('--env', `${k}=${v}`);
  argv.push(profile.image, ...input.command);
  assertSafeScannerArgv(argv);
  return { command: 'podman', argv };
}

/** Reject any hand-built argv that widens the profile. */
export function assertSafeScannerArgv(argv: readonly string[]): void {
  const text = argv.join(' ');
  const forbidden = ['--privileged', '--cap-add', '--network=host', '--pid=host', '--ipc=host', 'seccomp=unconfined', '--volume', ' -v ', '--device', 'podman.sock', '--user=0', '--user=root'];
  const hit = forbidden.find((f) => text.includes(f));
  if (hit) throw new ScannerProfileError('forbidden_argv', `forbidden scanner argv: ${hit}`);
  for (const a of argv) {
    if (a.startsWith('--mount=') && !/,ro=true$/.test(a)) throw new ScannerProfileError('writable_mount', `mount is not read-only: ${a}`);
  }
}

/** Redact scanner logs/findings/artifacts: host secrets, token shapes, and any extra planted values. */
export function redactScannerOutput<T>(value: T, extraSecrets: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): T {
  return redactDeep(value, [...collectSecretValues(env), ...extraSecrets].sort((a, b) => b.length - a.length));
}
export { REDACTED, redactSecrets };
