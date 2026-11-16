import { z } from 'zod';
import { REDACTED, SECRET_NAME_RE, collectSecretValues, redactDeep, redactSecrets } from '../../core/secret-redaction.js';

/**
 * Isolated scanner worker execution profile (#605). Scanners run unprivileged,
 * with read-only source/artifact mounts, an allowlisted environment (no ambient
 * credentials) and egress denied except for the declared advisory-DB-update
 * phase. Pure functions: nothing is spawned here; the caller runs the argv this
 * builds. Enforcement that cannot be guaranteed fails closed with a reason.
 */

export const scannerWorkerProfileSchema = z.object({
  image: z.string().min(1).max(512).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/),
  /** Resource request for the worker. */
  resources: z.object({
    cpus: z.number().positive().max(64),
    memoryMib: z.number().int().min(64).max(262_144),
    pids: z.number().int().min(16).max(8_192).default(256),
    timeoutMs: z.number().int().min(1_000).max(3_600_000),
  }).strict(),
  /** Absolute container paths; both are mounted read-only. */
  sourceMount: z.string().regex(/^\/[A-Za-z0-9._/-]+$/).default('/src'),
  artifactMount: z.string().regex(/^\/[A-Za-z0-9._/-]+$/).default('/artifacts'),
  /** Writable scratch space (tmpfs) the scanner may use. */
  scratchMount: z.string().regex(/^\/[A-Za-z0-9._/-]+$/).default('/scratch'),
  /** Env names the scanner may see (allowlist, never a denylist). */
  envAllowlist: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(32).default(['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR']),
  /** Hosts reachable during the advisory DB update phase only. */
  advisoryDbHosts: z.array(z.string().regex(/^[a-z0-9.-]+$/i)).max(8).default([]),
  /** Unprivileged uid:gid inside the container. */
  user: z.string().regex(/^[1-9]\d{0,8}:\d{1,9}$/).default('65534:65534'),
}).strict();
export type ScannerWorkerProfile = z.infer<typeof scannerWorkerProfileSchema>;

export type ScannerPhase = 'db-update' | 'scan';

export type ScannerProfileDenial =
  | 'unsupported_platform' | 'runtime_unavailable' | 'egress_not_enforceable' | 'secret_name_allowlisted'
  | 'host_path_invalid' | 'egress_without_allowlist';

export class ScannerProfileError extends Error {
  constructor(readonly reason: ScannerProfileDenial, message: string) {
    super(message);
    this.name = 'ScannerProfileError';
  }
}

export interface ScannerEnforcementProbe {
  platform: NodeJS.Platform | string;
  /** Rootless Podman (or equivalent) is installed and can enforce mounts/network. */
  containerRuntime: boolean;
  /** An egress allowlist (proxy/firewall) is available for the db-update phase. */
  egressAllowlist: boolean;
}

/**
 * Fail closed when mount and egress isolation cannot be enforced. Windows has no
 * equivalent unprivileged mount/egress primitive, so it is refused unless a
 * container runtime (WSL/Podman machine) is reported by the probe.
 */
export function assertScannerEnforceable(
  profile: ScannerWorkerProfile, phase: ScannerPhase, probe: ScannerEnforcementProbe,
): void {
  if (probe.platform !== 'linux' && probe.platform !== 'win32') {
    throw new ScannerProfileError('unsupported_platform', `scanner isolation is not supported on ${probe.platform}`);
  }
  if (!probe.containerRuntime) {
    const why = probe.platform === 'win32'
      ? 'Windows has no native read-only mount or egress control; a container runtime is required'
      : 'no rootless container runtime is available to enforce read-only mounts';
    throw new ScannerProfileError('runtime_unavailable', `scanner isolation fails closed: ${why}`);
  }
  if (phase === 'db-update') {
    if (profile.advisoryDbHosts.length === 0) {
      throw new ScannerProfileError('egress_without_allowlist', 'db-update phase requires a non-empty advisoryDbHosts allowlist');
    }
    if (!probe.egressAllowlist) {
      throw new ScannerProfileError('egress_not_enforceable', 'cannot enforce an egress allowlist for the db-update phase');
    }
  }
}

/** Build the scanner environment from the profile allowlist only. */
export function scrubScannerEnv(profile: ScannerWorkerProfile, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of profile.envAllowlist) {
    if (SECRET_NAME_RE.test(name)) {
      throw new ScannerProfileError('secret_name_allowlisted', `env allowlist may not include credential-like name ${name}`);
    }
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

export interface ScannerRunRequest {
  runId: string;
  phase: ScannerPhase;
  /** Absolute host paths (POSIX or Windows drive form). */
  hostSourcePath: string;
  hostArtifactPath: string;
  command: string[];
}

const HOST_PATH_RE = /^(\/[A-Za-z0-9._/@+-]+|[A-Za-z]:[\\/][A-Za-z0-9._\\/@+ -]+)$/;

/** Build the rootless podman argv. Nothing here can grant a writable source or host network. */
export function buildScannerArgv(
  profile: ScannerWorkerProfile, req: ScannerRunRequest, probe: ScannerEnforcementProbe,
  env: NodeJS.ProcessEnv = process.env,
): { command: 'podman'; argv: string[] } {
  assertScannerEnforceable(profile, req.phase, probe);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(req.runId)) throw new ScannerProfileError('host_path_invalid', 'invalid run id');
  for (const p of [req.hostSourcePath, req.hostArtifactPath]) {
    if (!HOST_PATH_RE.test(p) || p.includes('..') || p.includes(',')) {
      throw new ScannerProfileError('host_path_invalid', `unsafe host path: ${p}`);
    }
  }
  const argv = [
    'run', '--rm', '--name', `cezar-scan-${req.runId}`,
    '--user', profile.user, '--cap-drop=all', '--security-opt=no-new-privileges',
    '--read-only', '--pids-limit', String(profile.resources.pids),
    '--cpus', String(profile.resources.cpus), '--memory', `${profile.resources.memoryMib}m`,
    // db-update gets a private network that the egress allowlist fronts; scan gets none.
    '--network', req.phase === 'db-update' ? 'slirp4netns:allow_host_loopback=false' : 'none',
    '--mount', `type=bind,src=${req.hostSourcePath},dst=${profile.sourceMount},ro=true`,
    '--mount', `type=bind,src=${req.hostArtifactPath},dst=${profile.artifactMount},ro=true`,
    '--tmpfs', `${profile.scratchMount}:rw,noexec,nosuid,size=${Math.min(profile.resources.memoryMib, 512)}m`,
    '--workdir', profile.sourceMount,
  ];
  for (const [k, v] of Object.entries(scrubScannerEnv(profile, env))) argv.push('--env', `${k}=${v}`);
  if (req.phase === 'db-update') argv.push('--env', `CEZAR_EGRESS_ALLOW=${profile.advisoryDbHosts.join(',')}`);
  argv.push(profile.image, ...req.command);
  return { command: 'podman', argv };
}

/** Argv must never carry a writable bind, host network, privilege grant or ambient secret name. */
export function assertSafeScannerArgv(argv: readonly string[]): void {
  const text = argv.join(' ');
  if (/--privileged|--network[= ]host|--cap-add|--userns[= ]host|--pid[= ]host/.test(text)) {
    throw new ScannerProfileError('runtime_unavailable', 'scanner argv grants privilege or host namespaces');
  }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--mount' && /type=bind/.test(argv[i + 1] ?? '') && !/ro=true/.test(argv[i + 1] ?? '')) {
      throw new ScannerProfileError('runtime_unavailable', 'scanner bind mount is not read-only');
    }
    if (argv[i] === '--env' && SECRET_NAME_RE.test((argv[i + 1] ?? '').split('=')[0] ?? '')) {
      throw new ScannerProfileError('secret_name_allowlisted', 'scanner argv carries a credential-like env name');
    }
  }
}

/**
 * Redact scanner output, findings and artifact text before anything persists.
 * Redacts host secret values, known token shapes, and any extra literal values
 * (for example a planted fixture secret) supplied by the caller.
 */
export function redactScannerOutput<T>(value: T, extraSecrets: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): T {
  const secrets = [...new Set([...collectSecretValues(env), ...extraSecrets.filter((s) => s.length > 0)])]
    .sort((a, b) => b.length - a.length);
  return redactDeep(value, secrets);
}

export function redactScannerText(text: string, extraSecrets: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): string {
  return redactSecrets(text, [...new Set([...collectSecretValues(env), ...extraSecrets.filter((s) => s.length > 0)])].sort((a, b) => b.length - a.length));
}

export { REDACTED };
