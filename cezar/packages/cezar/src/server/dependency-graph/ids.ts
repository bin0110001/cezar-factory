import { createHash } from 'node:crypto';

/** Stable UUID-shaped identity makes replayed GitHub edges an upsert rather than a duplicate. */
export function stableDependencyEdgeId(from: string, to: string, kind: string): string {
  const bytes = createHash('sha256').update(`dependency-edge-v1\0${kind}\0${from}\0${to}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
