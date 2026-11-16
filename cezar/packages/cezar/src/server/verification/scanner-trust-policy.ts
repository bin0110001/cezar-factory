import { z } from 'zod';

/**
 * Trusted-scanner policy (#604), shared by every vulnerability provider.
 * A scanner is trusted only when pinned by digest, verified against that digest,
 * signed by a trusted source, present, and backed by a fresh advisory DB.
 * Every other state fails closed: the result is `fail` or `unknown`, never `pass`.
 */

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export const scannerTrustPolicySchema = z.object({
  provider: z.string().min(1).max(64),
  /** Image or binary reference. `latest`, a missing tag/digest, or a floating tag is refused. */
  reference: z.string().min(1).max(512),
  pinnedDigest: z.string().regex(DIGEST),
  signature: z.object({ required: z.literal(true).default(true), trustedSigners: z.array(z.string().min(1)).min(1).max(16) }).strict(),
  trustedSource: z.string().min(1).max(256),
  /** How a pin changes: a reviewed change to this policy, never an automatic refresh. */
  updateProcess: z.string().min(1).max(256),
  dbMaxAgeHours: z.number().positive().max(24 * 30),
}).strict();
export type ScannerTrustPolicy = z.infer<typeof scannerTrustPolicySchema>;

export interface ScannerObservation {
  binaryPresent: boolean;
  /** Digest computed from the binary/image actually about to run. */
  observedDigest?: string;
  /** Signer identity from a verified signature, absent when unsigned or unverifiable. */
  verifiedSigner?: string;
  dbUpdatedAt?: string;
  now: string;
}

export type ScannerTrustReason =
  | 'unpinned_reference' | 'binary_missing' | 'digest_mismatch' | 'unsigned' | 'untrusted_signer'
  | 'db_missing' | 'db_expired' | 'invalid_policy';

export interface ScannerTrustVerdict {
  trusted: boolean;
  /** `fail` for a scanner that is wrong, `unknown` when trust cannot be established. Never `pass`. */
  outcome: 'trusted' | 'fail' | 'unknown';
  reasons: ScannerTrustReason[];
}

const FLOATING = /(^|[:@/])(latest|main|master|dev|edge|nightly)$/i;

export function isPinnedReference(reference: string): boolean {
  if (FLOATING.test(reference)) return false;
  return DIGEST.test(reference.split('@')[1] ?? '') || /:[^/:@]+$/.test(reference) && !/:latest$/i.test(reference);
}

/** Evaluate a scanner against the policy. Unparseable policy is `unknown`, never trusted. */
export function evaluateScannerTrust(rawPolicy: unknown, obs: ScannerObservation): ScannerTrustVerdict {
  const parsed = scannerTrustPolicySchema.safeParse(rawPolicy);
  if (!parsed.success) return { trusted: false, outcome: 'unknown', reasons: ['invalid_policy'] };
  const policy = parsed.data;
  const fail: ScannerTrustReason[] = [];
  const unknown: ScannerTrustReason[] = [];

  if (!isPinnedReference(policy.reference)) fail.push('unpinned_reference');
  if (!obs.binaryPresent) unknown.push('binary_missing');
  else if (obs.observedDigest !== policy.pinnedDigest) fail.push('digest_mismatch');
  if (!obs.verifiedSigner) fail.push('unsigned');
  else if (!policy.signature.trustedSigners.includes(obs.verifiedSigner)) fail.push('untrusted_signer');

  const updated = obs.dbUpdatedAt ? Date.parse(obs.dbUpdatedAt) : NaN;
  const now = Date.parse(obs.now);
  if (Number.isNaN(updated)) unknown.push('db_missing');
  else if (Number.isNaN(now) || now - updated > policy.dbMaxAgeHours * 3_600_000 || updated > now) unknown.push('db_expired');

  const reasons = [...fail, ...unknown];
  if (!reasons.length) return { trusted: true, outcome: 'trusted', reasons };
  return { trusted: false, outcome: fail.length ? 'fail' : 'unknown', reasons };
}
