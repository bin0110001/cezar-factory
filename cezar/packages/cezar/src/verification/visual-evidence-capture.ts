import { createHash } from 'node:crypto';
import { z } from 'zod';
import { verificationArtifactRefSchema, verificationVisualEvidenceSchema } from '@open-mercato/cezar-contract';
import { storeCodingRunArtifact } from '../workspace/coding-run-artifacts.ts';

const MAX_VISUAL_CAPTURE_BYTES = 16 * 1024 * 1024;
type VisualEvidenceMetadata = Omit<z.infer<typeof verificationVisualEvidenceSchema>, 'contentSha256' | 'storageReference'>;

export interface VisualCaptureInput { sessionId: string; name: string; bytes: Uint8Array; mediaType: string }

/** Drop-in `saveArtifact` callback for Playwright/native adapters; refs can be attached to their owning check. */
export function createVisualEvidenceSaver(options: {
  evidenceFor: (capture: VisualCaptureInput) => VisualEvidenceMetadata;
  redaction: 'already-redacted';
  retentionDays?: number;
  home?: string;
  onStored?: (capture: VisualCaptureInput, reference: ReturnType<typeof verificationArtifactRefSchema.parse>) => void | Promise<void>;
}) {
  return async (capture: VisualCaptureInput): Promise<string> => {
    const reference = await storeVisualEvidence({
      content: capture.bytes, mediaType: capture.mediaType, evidence: options.evidenceFor(capture),
      redaction: options.redaction, retentionDays: options.retentionDays, home: options.home,
    });
    await options.onStored?.(capture, reference);
    return reference.path;
  };
}

/** Store a reviewed visual capture and return the only reference suitable for a verification check. */
export async function storeVisualEvidence(options: {
  content: Uint8Array;
  mediaType: string;
  evidence: VisualEvidenceMetadata;
  /** Binary media cannot be text-redacted; callers must inspect it before asserting this. */
  redaction: 'already-redacted';
  retentionDays?: number;
  home?: string;
  now?: Date;
}) {
  if (!(options.content instanceof Uint8Array) || options.content.byteLength === 0 || options.content.byteLength > MAX_VISUAL_CAPTURE_BYTES) {
    throw new Error(`visual capture must be non-empty and no larger than ${MAX_VISUAL_CAPTURE_BYTES} bytes`);
  }
  const kind = options.evidence.kind;
  const signatureOk = kind === 'png' || kind === 'diff'
    ? options.mediaType === 'image/png' && options.content.byteLength >= 8
      && Buffer.from(options.content.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : kind === 'video' ? options.mediaType === 'video/webm' && options.content.byteLength >= 4
      && Buffer.from(options.content.subarray(0, 4)).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
      : kind === 'trace' ? options.mediaType === 'application/zip' && options.content.byteLength >= 4
        && Buffer.from(options.content.subarray(0, 2)).equals(Buffer.from([0x50, 0x4b]))
        : kind === 'metadata' && options.mediaType.startsWith('text/');
  if (!signatureOk) throw new Error('visual capture media type or signature is invalid');
  const reference = await storeCodingRunArtifact({
    content: options.content, mediaType: options.mediaType, redaction: options.redaction,
    evidenceId: `${options.evidence.verificationId}:${options.evidence.sessionId}:${options.evidence.testId}:${options.evidence.attempt}`,
    retentionDays: options.retentionDays, home: options.home, now: options.now,
  });
  return verificationArtifactRefSchema.parse({
    path: reference.reference, mediaType: reference.mediaType, bytes: reference.bytes, sha256: reference.sha256,
    visualEvidence: {
      ...options.evidence,
      contentSha256: createHash('sha256').update(options.content).digest('hex'),
      storageReference: reference.reference,
      capturedAt: options.evidence.capturedAt,
      retention: reference.expiresAt,
    },
  });
}
