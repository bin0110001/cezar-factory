import { describe, expect, it } from 'vitest';
import {
  ScannerProfileError, assertSafeScannerArgv, assertScannerEnforceable, buildScannerArgv, redactScannerOutput,
  scannerWorkerProfileSchema, scrubScannerEnv, type ScannerRunRequest,
} from './scanner-worker-profile.js';

const profile = scannerWorkerProfileSchema.parse({
  image: 'localhost/cezar-scan:1',
  resources: { cpus: 2, memoryMib: 1024, timeoutMs: 60_000 },
  advisoryDbHosts: ['db.advisories.example'],
});
const linux = { platform: 'linux', containerRuntime: true, egressAllowlist: true };
const req = (over: Partial<ScannerRunRequest> = {}): ScannerRunRequest => ({
  runId: 'r1', phase: 'scan', hostSourcePath: '/work/src', hostArtifactPath: '/work/art', command: ['scanner', '--json'], ...over,
});
const reason = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as ScannerProfileError).reason; } return undefined; };
const ambient = {
  PATH: '/usr/bin', GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', GH_TOKEN: 'ghp_zzzzzzzzzzzzzzzzzzzzzzzzzzzz1234',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', MY_API_KEY: 'supersecretvalue123456',
};

describe('scanner env scrubbing', () => {
  it('shows the scanner no ambient credentials', () => {
    const env = scrubScannerEnv(profile, ambient);
    expect(env).toEqual({ PATH: '/usr/bin' });
    const { argv } = buildScannerArgv(profile, req(), linux, ambient);
    const text = argv.join(' ');
    for (const v of Object.values(ambient).filter((v) => v !== '/usr/bin')) expect(text).not.toContain(v);
    expect(text).not.toMatch(/GITHUB_TOKEN|GH_TOKEN|_KEY|_SECRET/);
  });
  it('refuses a credential-like allowlist entry', () => {
    const bad = { ...profile, envAllowlist: ['GITHUB_TOKEN'] };
    expect(reason(() => scrubScannerEnv(bad, ambient))).toBe('secret_name_allowlisted');
  });
});

describe('mounts and egress', () => {
  it('mounts source and artifacts read-only, unprivileged, with no network in scan phase', () => {
    const { argv } = buildScannerArgv(profile, req(), linux, ambient);
    const mounts = argv.filter((_, i) => argv[i - 1] === '--mount');
    expect(mounts).toHaveLength(2);
    for (const m of mounts) expect(m).toMatch(/ro=true/);
    expect(argv).toContain('--read-only');
    expect(argv).toContain('--cap-drop=all');
    expect(argv[argv.indexOf('--network') + 1]).toBe('none');
    expect(argv[argv.indexOf('--user') + 1]).toBe('65534:65534');
    expect(() => assertSafeScannerArgv(argv)).not.toThrow();
  });
  it('allows egress only in the db-update phase, bound to the allowlist', () => {
    const { argv } = buildScannerArgv(profile, req({ phase: 'db-update' }), linux, ambient);
    expect(argv[argv.indexOf('--network') + 1]).not.toBe('none');
    expect(argv).toContain('CEZAR_EGRESS_ALLOW=db.advisories.example');
    const noList = scannerWorkerProfileSchema.parse({ ...profile, advisoryDbHosts: [] });
    expect(reason(() => assertScannerEnforceable(noList, 'db-update', linux))).toBe('egress_without_allowlist');
    expect(reason(() => assertScannerEnforceable(profile, 'db-update', { ...linux, egressAllowlist: false }))).toBe('egress_not_enforceable');
  });
  it('rejects a writable bind or privilege grant in argv', () => {
    expect(reason(() => assertSafeScannerArgv(['--mount', 'type=bind,src=/a,dst=/src']))).toBe('runtime_unavailable');
    expect(reason(() => assertSafeScannerArgv(['--network=host']))).toBe('runtime_unavailable');
  });
  it('rejects unsafe host paths', () => {
    expect(reason(() => buildScannerArgv(profile, req({ hostSourcePath: '/work/../etc' }), linux))).toBe('host_path_invalid');
    expect(reason(() => buildScannerArgv(profile, req({ hostSourcePath: '/a,dst=/x' }), linux))).toBe('host_path_invalid');
  });
});

describe('platform portability', () => {
  it('fails closed without a runtime on Linux and Windows, with a clear reason', () => {
    expect(reason(() => assertScannerEnforceable(profile, 'scan', { ...linux, containerRuntime: false }))).toBe('runtime_unavailable');
    expect(() => assertScannerEnforceable(profile, 'scan', { platform: 'win32', containerRuntime: false, egressAllowlist: false }))
      .toThrow(/Windows has no native/);
    expect(reason(() => assertScannerEnforceable(profile, 'scan', { ...linux, platform: 'darwin' }))).toBe('unsupported_platform');
  });
  it('accepts Windows host paths when a runtime is present', () => {
    const win = { platform: 'win32', containerRuntime: true, egressAllowlist: true };
    expect(() => buildScannerArgv(profile, req({ hostSourcePath: 'C:\\work\\src', hostArtifactPath: 'C:\\work\\art' }), win)).not.toThrow();
  });
});

describe('redaction', () => {
  it('redacts a planted fixture secret in logs, findings and artifacts', () => {
    const planted = 'fixture-planted-secret-value-9876';
    const output = {
      log: `scan started token=${planted} and ${ambient.GITHUB_TOKEN}`,
      findings: [{ id: 'f1', message: `leak ${planted}`, evidence: { snippet: `key=${ambient.AWS_SECRET_ACCESS_KEY}` } }],
      artifacts: [{ name: 'report.sarif', text: planted }],
    };
    const redacted = JSON.stringify(redactScannerOutput(output, [planted], ambient));
    for (const s of [planted, ambient.GITHUB_TOKEN, ambient.AWS_SECRET_ACCESS_KEY]) expect(redacted).not.toContain(s);
    expect(redacted).toContain('[REDACTED]');
  });
});
