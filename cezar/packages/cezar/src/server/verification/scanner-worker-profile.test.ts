import { describe, expect, it } from 'vitest';
import {
  ScannerProfileError, assertSafeScannerArgv, buildScannerArgv, planScannerEnforcement, redactScannerOutput,
  scannerWorkerProfileSchema, scrubScannerEnv,
} from './scanner-worker-profile.js';

const profile = scannerWorkerProfileSchema.parse({
  image: 'localhost/scanner:1', mounts: { source: '/src', artifacts: '/artifacts' }, advisoryDbHosts: ['db.example.org'],
});
const reason = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as ScannerProfileError).reason; } return undefined; };
const run = { phase: 'scan' as const, sourceHostPath: '/w/src', artifactsHostPath: '/w/art', command: ['scan', '/src'] };
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

describe('scanner env', () => {
  it('exposes no ambient credentials', () => {
    const env = { PATH: '/bin', LANG: 'C', GITHUB_TOKEN: SECRET, GH_TOKEN: SECRET, AWS_SECRET_ACCESS_KEY: 'x'.repeat(30), HOME: '/root' };
    expect(scrubScannerEnv(profile, env)).toEqual({ PATH: '/bin', LANG: 'C' });
    const { argv } = buildScannerArgv(profile, run, env);
    expect(argv.join(' ')).not.toContain(SECRET);
  });
  it('refuses secret-named allowlist entries', () => {
    const p = scannerWorkerProfileSchema.parse({ ...profile, envAllowlist: ['PATH', 'GITHUB_TOKEN'] });
    expect(reason(() => scrubScannerEnv(p, { GITHUB_TOKEN: SECRET }))).toBe('secret_env_allowlisted');
  });
});

describe('mounts and egress', () => {
  it('mounts source and artifacts read-only with no network during scan', () => {
    const { argv } = buildScannerArgv(profile, run, {});
    const mounts = argv.filter((a) => a.startsWith('--mount='));
    expect(argv).toContain('--network=none');
    expect(mounts).toHaveLength(2);
    expect(mounts.every((a) => a.endsWith(',ro=true'))).toBe(true);
  });
  it('rejects writable mounts and widened argv', () => {
    expect(reason(() => assertSafeScannerArgv(['--mount=type=bind,src=/a,dst=/b']))).toBe('writable_mount');
    for (const bad of ['--privileged', '--network=host', '--cap-add=ALL', '--volume=/a:/b']) expect(reason(() => assertSafeScannerArgv([bad]))).toBe('forbidden_argv');
  });
  it('allows egress only in db-update and only to allowlisted hosts', () => {
    expect(reason(() => buildScannerArgv(profile, { ...run, egressHosts: ['db.example.org'] }, {}))).toBe('egress_outside_db_update');
    expect(reason(() => buildScannerArgv(profile, { ...run, phase: 'db-update', egressHosts: ['evil.example.com'] }, {}))).toBe('unknown_egress_host');
    const { argv } = buildScannerArgv(profile, { ...run, phase: 'db-update', egressHosts: ['db.example.org'] }, {});
    expect(argv).not.toContain('--network=none');
  });
});

describe('platform enforcement', () => {
  it('fails closed on Windows and without podman, passes on Linux', () => {
    expect(reason(() => planScannerEnforcement('win32', { podman: true }))).toBe('unsupported_platform');
    expect(reason(() => planScannerEnforcement('linux', {}))).toBe('no_container_runtime');
    expect(planScannerEnforcement('linux', { podman: true }).command).toBe('podman');
  });
});

describe('redaction', () => {
  it('redacts a planted fixture secret in logs, findings and artifacts', () => {
    const planted = 'fixture-planted-value-0123456789';
    const out = redactScannerOutput({ log: `found ${planted} and ${SECRET}`, findings: [{ msg: planted }], artifact: { raw: `x${planted}` } }, [planted], {});
    const text = JSON.stringify(out);
    expect(text).not.toContain(planted);
    expect(text).not.toContain(SECRET);
    expect(text).toContain('[REDACTED]');
  });
});
