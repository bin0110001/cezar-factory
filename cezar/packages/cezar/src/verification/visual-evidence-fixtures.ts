import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { verificationRunSchema, type VerificationRun } from '@open-mercato/cezar-contract';
import { compareVisual, policySha256, type BaselineRecord, type RawImage, type RendererFingerprint, type VisualPolicy } from './visual-baseline.ts';

/**
 * Fixtures that produce comparable visual evidence for the #354 gallery. A browser (Playwright-style) and a
 * Godot rendered-scene capture go through the same `compareVisual` path and the same artifact contract
 * (`verificationArtifactRefSchema` + `visualEvidence`); only the renderer fingerprint differs.
 */
export type FixtureAdapter = 'browser' | 'godot';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/** Minimal RGBA8 PNG encoder so fixtures are real, previewable PNG files. */
export function encodePng(image: RawImage): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(image.width, 0); ihdr.writeUInt32BE(image.height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = Buffer.alloc((image.width * 4 + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) Buffer.from(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4)).copy(rows, y * (image.width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

export function fixtureRenderer(adapter: FixtureAdapter): RendererFingerprint {
  return adapter === 'browser'
    ? { os: 'linux', resolution: { width: 4, height: 4 }, dpi: 96, displayBackend: 'chromium-headless', renderer: 'software', graphicsApi: null, driver: null, appVersion: 'chromium-130', colorSettings: {}, renderFeatures: [] }
    : { os: 'linux', resolution: { width: 4, height: 4 }, dpi: 96, displayBackend: 'x11-xvfb', renderer: 'software', graphicsApi: 'opengl', driver: 'llvmpipe', appVersion: 'godot-4.4', colorSettings: {}, renderFeatures: ['canvas'] };
}

export const fixturePolicy: VisualPolicy = { version: 1, channelTolerance: 0, maxDiffRatio: 0, masks: [], maxMaskedRatio: 0.1 };

export function solidImage(rgba: [number, number, number, number], size = 4): RawImage {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width: size, height: size, data };
}

export interface FixtureOptions {
  adapter: FixtureAdapter;
  verificationId: string;
  commitSha?: string;
  /** Session roles that each capture the scene (for example host and guest). */
  roles?: string[];
  /** Change a pixel in the actual capture so the comparison fails and a diff is produced. */
  regress?: boolean;
  accessPolicy?: 'private' | 'project' | 'link';
  redactionState?: 'redacted' | 'unredacted' | 'unknown';
  /** Render the baseline with a different renderer to exercise incompatible-baseline handling. */
  baselineRenderer?: RendererFingerprint;
}

export function buildVisualEvidenceFixture(options: FixtureOptions): { run: VerificationRun; files: Map<string, Buffer> } {
  const commitSha = options.commitSha ?? '1'.repeat(40);
  const manifestSha256 = '2'.repeat(64);
  const renderer = fixtureRenderer(options.adapter);
  const baselineRenderer = options.baselineRenderer ?? renderer;
  const expected = solidImage([10, 20, 30, 255]);
  const actual = solidImage([10, 20, 30, 255]);
  if (options.regress) actual.data[0] = 200;
  const baseline: BaselineRecord = { baselineId: `${options.adapter}-scene`, image: expected, renderer: baselineRenderer, commitSha, changeReason: 'fixture baseline', approvedBy: 'reviewer', approvedAt: '2026-11-01T00:00:00.000Z', policySha256: policySha256(fixturePolicy) };
  const outcome = compareVisual({ actual, actualRenderer: renderer, candidates: [baseline], policy: fixturePolicy });
  const files = new Map<string, Buffer>();
  const artifacts: VerificationRun['artifacts'] = [];
  const add = (kind: 'png' | 'diff', role: string, name: string, image: RawImage, at: string) => {
    const bytes = encodePng(image);
    const path = `evidence/${options.verificationId}/${name}.png`;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    files.set(path, bytes);
    artifacts.push({
      path, mediaType: 'image/png', bytes: bytes.byteLength, sha256,
      visualEvidence: {
        version: 1, kind, contentSha256: sha256, verificationId: options.verificationId, attempt: 1, role, sessionId: `session-${role}`, testId: 'scene',
        commitSha, manifestSha256, policyVersion: 'visual-policy-1', workerFingerprint: 'worker-fixture', capturedAt: at, retention: 'p30d',
        accessPolicy: options.accessPolicy ?? 'project', redactionState: options.redactionState ?? 'redacted', storageReference: path,
        renderer: role === 'expected' ? baselineRenderer : renderer,
      },
    });
  };
  add('png', 'expected', 'expected', expected, '2026-11-10T10:00:00.000Z');
  (options.roles ?? ['actual']).forEach((role, index) => add('png', role, `actual-${role}`, actual, `2026-11-10T10:00:0${index + 1}.000Z`));
  if (outcome.diff) add('diff', 'diff', 'diff', outcome.diff, '2026-11-10T10:00:09.000Z');
  const failed = outcome.status === 'failed';
  const status = failed ? 'failed' : outcome.status === 'passed' ? 'passed' : 'unknown';
  const run = verificationRunSchema.parse({
    resultVersion: 1, verificationId: options.verificationId, cezarRunId: options.verificationId, projectId: 'project', worktreeId: 'worktree',
    commitSha, manifestSha256, startedAt: '2026-11-10T10:00:00.000Z', finishedAt: '2026-11-10T10:01:00.000Z', toolVersions: {}, environment: {},
    status, semanticExitCode: failed ? 1 : status === 'unknown' ? 2 : 0,
    coverage: { selected: 1, passed: status === 'passed' ? 1 : 0, failed: failed ? 1 : 0, skipped: 0, unknown: status === 'unknown' ? 1 : 0 },
    checks: [{
      checkId: 'scene', required: true, attempt: 1, status, rawExitCode: failed ? 1 : 0, semanticExitCode: failed ? 1 : status === 'unknown' ? 2 : 0,
      durationMs: 10, outputPreview: outcome.reason, outputTruncated: false, diagnostics: [], metrics: outcome.metrics,
      coverage: { selected: 1, passed: status === 'passed' ? 1 : 0, skipped: 0 }, artifacts,
    }],
    artifacts: [],
  });
  return { run, files };
}
