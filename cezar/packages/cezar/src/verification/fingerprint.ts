import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { verificationFindingKindSchema, verificationFingerprintStrategySchema } from '@open-mercato/cezar-contract';

export type VerificationFindingKind = z.infer<typeof verificationFindingKindSchema>;

export const FINGERPRINT_STRATEGIES: Readonly<Record<VerificationFindingKind, z.infer<typeof verificationFingerprintStrategySchema>>> = {
  'parse-error': { id: 'cezar.verification.parse-error', version: 1, kinds: ['parse-error'] },
  'test-failure': { id: 'cezar.verification.test-failure', version: 1, kinds: ['test-failure'] },
  'startup-error': { id: 'cezar.verification.startup-error', version: 1, kinds: ['startup-error'] },
  'performance-finding': { id: 'cezar.verification.performance-finding', version: 1, kinds: ['performance-finding'] },
};

export interface VerificationFindingInput {
  kind: VerificationFindingKind;
  checkId: string;
  code?: string;
  message: string;
  /** Location is evidence for display only; it is intentionally excluded from identity. */
  file?: string;
  line?: number;
  column?: number;
}

export interface FingerprintedFinding {
  fingerprint: string;
  strategyId: string;
  strategyVersion: number;
}

export type FingerprintAliases = Readonly<Record<string, string>>;

export function normalizeFindingMessage(message: string): string {
  return message
    .normalize('NFKC')
    .replace(/\b\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?Z?\b/gi, '')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|msec|milliseconds?|seconds?|secs?|minutes?|mins?)\b/gi, '')
    .replace(/\b(?:pid|process(?:\s+id)?)\s*[=: ]\s*\d+\b/gi, '')
    .replace(/\b(?:port|tcp|udp)\s*[=: ]\s*\d+\b/gi, '')
    .replace(/\b0x[\da-f]{6,}\b/gi, '')
    .replace(/\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/gi, '')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}\b/g, '')
    .replace(/\b(?:localhost|127\.0\.0\.1):\d{1,5}\b/gi, '')
    .replace(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s:'"()]+[\\/])+[^\s:'"(),;]+/g, '<path>')
    .replace(/\b(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z0-9]+\b/g, '<path>')
    .replace(/\b(line|column|col)\s*[:#]?\s*\d+\b/gi, '$1=<location>')
    .replace(/([:@(])\d+(?::\d+)?\)?/g, '$1<location>')
    .replace(/\(\s*(?:[,;]\s*)*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Stable identity ignores source location and volatile runtime details, while retaining the
 * check, failure class, diagnostic code and normalized message to limit accidental collisions. */
export function fingerprintFinding(input: VerificationFindingInput): FingerprintedFinding {
  const strategy = FINGERPRINT_STRATEGIES[input.kind];
  verificationFingerprintStrategySchema.parse(strategy);
  const identity = [
    input.kind,
    input.checkId.trim().toLowerCase(),
    input.code?.trim().toLowerCase() ?? '',
    normalizeFindingMessage(input.message),
  ].join('\0');
  return {
    fingerprint: createHash('sha256').update(identity, 'utf8').digest('hex'),
    strategyId: strategy.id,
    strategyVersion: strategy.version,
  };
}

/** Resolve explicit old-fingerprint -> new-fingerprint aliases, rejecting cycles. */
export function resolveFingerprintAlias(fingerprint: string, aliases: FingerprintAliases): string {
  const visited = new Set<string>();
  let current = fingerprint;
  while (aliases[current]) {
    if (visited.has(current)) throw new Error(`fingerprint alias cycle at ${current}`);
    visited.add(current);
    current = aliases[current]!;
  }
  return current;
}

/** A version change must ship explicit identity mappings for fingerprints already in storage. */
export function assertVersionBumpHasAliases(
  previousVersion: number,
  nextVersion: number,
  aliases: FingerprintAliases,
): void {
  if (!Number.isInteger(previousVersion) || previousVersion < 1 || !Number.isInteger(nextVersion) || nextVersion <= previousVersion) {
    throw new Error('fingerprint strategy version must increase to a positive integer');
  }
  if (Object.keys(aliases).length === 0) throw new Error('fingerprint strategy version bump requires explicit aliases');
  for (const [from, to] of Object.entries(aliases)) {
    if (!/^[a-f0-9]{64}$/.test(from) || !/^[a-f0-9]{64}$/.test(to)) {
      throw new Error('fingerprint aliases must map 64-character lowercase sha256 values');
    }
    resolveFingerprintAlias(from, aliases);
  }
}
