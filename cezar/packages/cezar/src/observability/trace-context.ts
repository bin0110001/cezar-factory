import { createHash, randomBytes } from 'node:crypto';

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const ZERO_TRACE_ID = '00000000000000000000000000000000';
const ZERO_SPAN_ID = '0000000000000000';

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceFlags: string;
  traceparent: string;
  parentSpanId?: string;
}

function validId(value: string, zero: string): boolean {
  return value !== zero;
}

export function parseTraceparent(value: string | undefined): TraceContext | undefined {
  if (!value) return undefined;
  const match = TRACEPARENT_RE.exec(value.trim());
  if (!match) return undefined;
  const [, traceId, spanId, traceFlags] = match;
  if (!traceId || !spanId || !traceFlags || !validId(traceId.toLowerCase(), ZERO_TRACE_ID)
    || !validId(spanId.toLowerCase(), ZERO_SPAN_ID)) return undefined;
  return { traceId: traceId.toLowerCase(), spanId: spanId.toLowerCase(), traceFlags: traceFlags.toLowerCase(), traceparent: value.trim() };
}

function stableHex(seed: string, bytes: number): string {
  return createHash('sha256').update(`cezar-otel-v1\0${seed}`).digest('hex').slice(0, bytes * 2);
}

function randomSpanId(): string {
  return randomBytes(8).toString('hex');
}

export function stableSpanId(identity: string): string {
  let spanId = stableHex(`span:${identity}`, 8);
  if (!validId(spanId, ZERO_SPAN_ID)) spanId = `1${spanId.slice(1)}`;
  return spanId;
}

export function createTraceContext(options: {
  identity: string;
  parentTraceparent?: string;
  sample?: boolean;
  spanId?: string;
}): TraceContext {
  const parent = parseTraceparent(options.parentTraceparent);
  const traceId = parent?.traceId ?? stableHex(`trace:${options.identity}`, 16);
  const spanId = options.spanId ?? randomSpanId();
  if (!validId(spanId.toLowerCase(), ZERO_SPAN_ID)) throw new Error('trace span id cannot be all zeroes');
  const traceFlags = parent?.traceFlags ?? (options.sample ? '01' : '00');
  return {
    traceId,
    spanId: spanId.toLowerCase(),
    traceFlags,
    traceparent: `00-${traceId}-${spanId.toLowerCase()}-${traceFlags}`,
    ...(parent ? { parentSpanId: parent.spanId } : {}),
  };
}

export function createChildTraceContext(parentValue: string, identity: string): TraceContext {
  const parent = parseTraceparent(parentValue);
  if (!parent) throw new Error('cannot create a child from an invalid traceparent');
  const spanId = stableSpanId(`${parent.traceId}:${parent.spanId}:${identity}`);
  return {
    traceId: parent.traceId,
    spanId,
    traceFlags: parent.traceFlags,
    traceparent: `00-${parent.traceId}-${spanId}-${parent.traceFlags}`,
    parentSpanId: parent.spanId,
  };
}

const SAFE_ATTRIBUTE_KEYS = new Set([
  'service.name', 'workflow.name', 'workflow.step', 'workflow.kind', 'run.id', 'run.attempt_id',
  'issue.number', 'project.id', 'worker.id', 'agent.provider', 'agent.adapter', 'model.id',
  'outcome', 'error.code', 'retry.count',
]);

/** Strict attribute allowlist: prompt text, source, commands, errors and credentials never pass. */
export function safeTelemetryAttributes(input: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!SAFE_ATTRIBUTE_KEYS.has(key) || (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')) continue;
    const bounded = String(value).replace(/[\r\n\0]/g, ' ').trim().slice(0, 128);
    if (bounded) result[key] = bounded;
  }
  return result;
}
