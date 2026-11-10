import { ROUTING_STATES } from './event.ts';

/**
 * Redaction for routing events (#94). Events are built by ALLOW-LIST: only known fields are copied,
 * so prompts, messages, headers, env and any other free-form field are dropped by construction.
 * Free-text fields and log payloads are additionally scrubbed for secret-shaped values.
 */
export const REDACTED = '[REDACTED]';

const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi,
  /\bBasic\s+[A-Za-z0-9+\/=]{8,}/gi,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{8,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/g,
  /\b(?:api[_-]?key|token|secret|password|passwd|authorization)\s*[=:]\s*\S+/gi,
];

const SENSITIVE_KEY = /(authorization|api[_-]?key|apikey|token|secret|password|passwd|credential|cookie|prompt|messages?|content|env)/i;

export function scrubString(value: string): string {
  let out = value;
  for (const p of SECRET_PATTERNS) out = out.replace(p, REDACTED);
  return out;
}

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length > 0 ? scrubString(v).slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : undefined);
const prune = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const rec = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** Build a redacted, allow-listed event candidate (sequence/schemaVersion/timestamp left to the store). */
export function redactEvent(input: unknown): Record<string, unknown> {
  const e = rec(input) ?? {};
  const sel = rec(e.selected);
  const q = rec(e.quotaSnapshot);
  const state = typeof e.state === 'string' && (ROUTING_STATES as readonly string[]).includes(e.state) ? e.state : e.state === undefined ? undefined : 'invalid';
  const selected = sel ? prune({ model: str(sel.model, 128), tier: str(sel.tier, 64), subscriptionAlias: str(sel.subscriptionAlias, 128) }) : undefined;
  const quotaSnapshot = q ? prune({ limit: num(q.limit), used: num(q.used), remaining: num(q.remaining), ratio: num(q.ratio), resetAt: str(q.resetAt, 40) }) : undefined;
  return prune({
    timestamp: str(e.timestamp, 40),
    eventId: str(e.eventId, 128), runId: str(e.runId, 128), attemptId: str(e.attemptId, 128), traceId: str(e.traceId, 128),
    attempt: int(e.attempt),
    state,
    selected: selected && Object.keys(selected).length ? selected : undefined,
    decisionReason: str(e.decisionReason, 512),
    deferralReason: str(e.deferralReason, 512),
    fallback: typeof e.fallback === 'boolean' ? e.fallback : undefined,
    forecastConfidence: typeof e.forecastConfidence === 'number' && Number.isFinite(e.forecastConfidence) && e.forecastConfidence >= 0 && e.forecastConfidence <= 1 ? e.forecastConfidence : undefined,
    quotaSnapshot: quotaSnapshot && Object.keys(quotaSnapshot).length ? quotaSnapshot : undefined,
  });
}

/** Deep-redact an arbitrary structured log payload: sensitive keys masked, secret-shaped strings scrubbed. */
export function redactLogPayload(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redactLogPayload(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? REDACTED : redactLogPayload(v, depth + 1)]));
}

export type LogFn = (line: string) => void;
/** Wrap a logger so every structured line is redacted before it is written. */
export function safeLogger(write: LogFn): (payload: Record<string, unknown>) => void {
  return (payload) => write(JSON.stringify(redactLogPayload(payload)));
}
