import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { z } from 'zod';
import { verificationArtifactRefSchema, verificationVisualEvidenceSchema } from '@open-mercato/cezar-contract';
import { storeCodingRunArtifact } from '../workspace/coding-run-artifacts.ts';

const MAX_VISUAL_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_DECODED_PNG_BYTES = 64 * 1024 * 1024;
type VisualEvidenceMetadata = Omit<z.infer<typeof verificationVisualEvidenceSchema>, 'contentSha256' | 'storageReference' | 'retention'>;

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function validPng(bytes: Uint8Array): boolean {
  const input = Buffer.from(bytes);
  if (input.byteLength < 45 || !input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  let offset = 8;
  let width = 0;
  let height = 0;
  let rowBytes = 0;
  let sawHeader = false;
  let sawData = false;
  let sawEnd = false;
  const compressed: Buffer[] = [];
  while (offset + 12 <= input.byteLength) {
    const length = input.readUInt32BE(offset);
    if (length > input.byteLength - offset - 12) return false;
    const type = input.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    let crc = 0xffffffff;
    for (const byte of input.subarray(offset + 4, dataEnd)) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    if (((crc ^ 0xffffffff) >>> 0) !== input.readUInt32BE(dataEnd)) return false;
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) return false;
      width = input.readUInt32BE(dataStart); height = input.readUInt32BE(dataStart + 4);
      if (!width || !height || width > 16_384 || height > 16_384) return false;
      const bitDepth = input[dataStart + 8]!;
      const colorType = input[dataStart + 9]!;
      const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
      const allowedDepths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!channels[colorType] || !allowedDepths[colorType]?.includes(bitDepth)
        || input[dataStart + 10] !== 0 || input[dataStart + 11] !== 0 || input[dataStart + 12] !== 0) return false;
      rowBytes = Math.ceil(width * channels[colorType]! * bitDepth / 8);
      if ((rowBytes + 1) * height > MAX_DECODED_PNG_BYTES) return false;
      sawHeader = true;
    } else if (type === 'IHDR') return false;
    if (type === 'IDAT') { sawData = true; compressed.push(input.subarray(dataStart, dataEnd)); }
    if (type === 'IEND') {
      if (length !== 0 || !sawData || dataEnd + 4 !== input.byteLength) return false;
      sawEnd = true;
      break;
    }
    offset = dataEnd + 4;
  }
  if (!sawHeader || !sawData || !sawEnd) return false;
  try {
    const decoded = inflateSync(Buffer.concat(compressed), { maxOutputLength: MAX_DECODED_PNG_BYTES });
    if (decoded.byteLength !== (rowBytes + 1) * height) return false;
    for (let offset = 0; offset < decoded.byteLength; offset += rowBytes + 1) if (decoded[offset]! > 4) return false;
    return true;
  } catch { return false; }
}

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
    ? options.mediaType === 'image/png' && validPng(options.content)
    : kind === 'jpeg' ? options.mediaType === 'image/jpeg' && options.content.byteLength >= 3
      && Buffer.from(options.content.subarray(0, 3)).equals(Buffer.from([0xff, 0xd8, 0xff]))
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
      retention: reference.expiresAt,
    },
  });
}
