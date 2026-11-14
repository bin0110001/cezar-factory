import { z } from 'zod';

export const SESSION_CONTROL_SCHEMA_VERSION = 1 as const;

export const SESSION_CONTROL_LIMITS = {
  maxRequestBytes: 16_384,
  maxResponseBytes: 262_144,
  maxScreenshotBytes: 4_194_304,
  maxSnapshotNodes: 500,
  maxSnapshotText: 512,
  maxTextInput: 4_096,
  maxWaitMs: 30_000,
  maxRequestsPerMinute: 60,
} as const;

export const sessionControlCapabilitySchema = z.enum(['observe', 'control']);
export type SessionControlCapability = z.infer<typeof sessionControlCapabilitySchema>;

const sessionControlTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('selector'), value: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal('role'), value: z.string().min(1).max(128), name: z.string().max(512).optional() }).strict(),
  z.object({ kind: z.literal('text'), value: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal('testId'), value: z.string().min(1).max(256) }).strict(),
]);

const timeoutSchema = z.number().int().min(50).max(SESSION_CONTROL_LIMITS.maxWaitMs);

export const sessionControlActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('metadata') }).strict(),
  z.object({ type: z.literal('screenshot'), format: z.enum(['png', 'jpeg']).default('png'), fullPage: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal('accessibilitySnapshot'), maxNodes: z.number().int().min(1).max(SESSION_CONTROL_LIMITS.maxSnapshotNodes).default(100) }).strict(),
  z.object({
    type: z.literal('navigate'), url: z.string().min(1).max(2_048).url().refine((value) => /^https?:\/\//i.test(value), 'navigation URL must use HTTP or HTTPS'),
    waitUntil: z.enum(['domContentLoaded', 'load', 'networkIdle']).default('domContentLoaded'),
    timeoutMs: timeoutSchema.default(10_000),
  }).strict(),
  z.object({ type: z.literal('click'), target: sessionControlTargetSchema, timeoutMs: timeoutSchema.default(5_000) }).strict(),
  z.object({ type: z.literal('type'), target: sessionControlTargetSchema, text: z.string().max(SESSION_CONTROL_LIMITS.maxTextInput), timeoutMs: timeoutSchema.default(5_000) }).strict(),
  z.object({ type: z.literal('key'), key: z.string().min(1).max(64).regex(/^[A-Za-z0-9+_-]+$/) }).strict(),
  z.object({ type: z.literal('scroll'), deltaX: z.number().int().min(-10_000).max(10_000).default(0), deltaY: z.number().int().min(-10_000).max(10_000).default(0) }).strict(),
  z.object({
    type: z.literal('waitForCondition'), condition: z.enum(['domReady', 'targetVisible', 'url']),
    target: sessionControlTargetSchema.optional(), url: z.string().min(1).max(2_048).optional(), timeoutMs: timeoutSchema.default(10_000),
  }).strict().superRefine((action, ctx) => {
    if (action.condition === 'targetVisible' && !action.target) ctx.addIssue({ code: 'custom', path: ['target'], message: 'targetVisible requires a target' });
    if (action.condition !== 'targetVisible' && action.target) ctx.addIssue({ code: 'custom', path: ['target'], message: 'target is only valid for targetVisible' });
    if (action.condition === 'url' && !action.url) ctx.addIssue({ code: 'custom', path: ['url'], message: 'url condition requires a URL' });
    if (action.condition !== 'url' && action.url) ctx.addIssue({ code: 'custom', path: ['url'], message: 'url is only valid for the url condition' });
  }),
  z.object({ type: z.literal('requestStop'), reason: z.string().min(1).max(256) }).strict(),
]);
export type SessionControlAction = z.infer<typeof sessionControlActionSchema>;

const controlActionTypes = new Set<SessionControlAction['type']>([
  'navigate', 'click', 'type', 'key', 'scroll', 'requestStop',
]);

/** Capability must come from the authenticated session grant, never from the request body. */
export function sessionControlActionAllowed(capability: SessionControlCapability, action: SessionControlAction): boolean {
  return capability === 'control' || !controlActionTypes.has(action.type);
}

/** The adapter tracks each authenticated session's rolling one-minute request window. */
export function sessionControlRateLimited(requestsInWindow: number): boolean {
  return !Number.isSafeInteger(requestsInWindow)
    || requestsInWindow < 0
    || requestsInWindow >= SESSION_CONTROL_LIMITS.maxRequestsPerMinute;
}

function jsonByteLength(value: unknown): number {
  let bytes = 0;
  for (const character of JSON.stringify(value)) {
    const codePoint = character.codePointAt(0)!;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export const sessionControlRequestSchema = z.object({
  schemaVersion: z.literal(SESSION_CONTROL_SCHEMA_VERSION),
  requestId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  action: sessionControlActionSchema,
}).strict().superRefine((request, ctx) => {
  if (jsonByteLength(request) > SESSION_CONTROL_LIMITS.maxRequestBytes) {
    ctx.addIssue({ code: 'custom', message: 'serialized session-control request exceeds the byte limit' });
  }
});
export type SessionControlRequest = z.infer<typeof sessionControlRequestSchema>;

export const sessionControlErrorCodeSchema = z.enum([
  'app_not_ready', 'wrong_session', 'stale_lease', 'denied_control', 'stale_dom',
  'inaccessible_widget', 'transient_render', 'lost_worker', 'rate_limited', 'response_too_large',
]);

const sessionControlErrorSchema = z.object({
  ok: z.literal(false),
  schemaVersion: z.literal(SESSION_CONTROL_SCHEMA_VERSION),
  requestId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  error: z.object({
    code: sessionControlErrorCodeSchema,
    message: z.string().min(1).max(512),
    retryAfterMs: z.number().int().min(0).max(60_000).optional(),
  }).strict(),
}).strict();

const sessionControlResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('metadata'), title: z.string().max(512), url: z.string().max(2_048), readyState: z.enum(['loading', 'interactive', 'complete']) }).strict(),
  z.object({ kind: z.literal('screenshot'), reference: z.string().min(1).max(1_024), mediaType: z.enum(['image/png', 'image/jpeg']), bytes: z.number().int().nonnegative().max(SESSION_CONTROL_LIMITS.maxScreenshotBytes), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ kind: z.literal('accessibilitySnapshot'), nodes: z.array(z.object({ id: z.string().max(128), role: z.string().max(128), name: z.string().max(SESSION_CONTROL_LIMITS.maxSnapshotText), disabled: z.boolean().optional(), level: z.number().int().min(1).max(10).optional() }).strict()).max(SESSION_CONTROL_LIMITS.maxSnapshotNodes), truncated: z.boolean() }).strict(),
  z.object({ kind: z.literal('action'), completed: z.boolean() }).strict(),
]);

const sessionControlSuccessSchema = z.object({
  ok: z.literal(true),
  schemaVersion: z.literal(SESSION_CONTROL_SCHEMA_VERSION),
  requestId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  result: sessionControlResultSchema,
}).strict();

export const sessionControlResponseSchema = z.discriminatedUnion('ok', [
  sessionControlSuccessSchema,
  sessionControlErrorSchema,
]).superRefine((response, ctx) => {
  if (jsonByteLength(response) > SESSION_CONTROL_LIMITS.maxResponseBytes) {
    ctx.addIssue({ code: 'custom', message: 'serialized session-control response exceeds the byte limit' });
  }
});
export type SessionControlResponse = z.infer<typeof sessionControlResponseSchema>;

const traceIdSchema = z.string().min(1).max(128);

/** Metadata-only action parameters: never text input, selectors, names, URL paths/queries, key values or stop reasons. */
export const sessionControlTraceParamsSchema = z.object({
  format: z.enum(['png', 'jpeg']).optional(),
  fullPage: z.boolean().optional(),
  maxNodes: z.number().int().min(1).max(SESSION_CONTROL_LIMITS.maxSnapshotNodes).optional(),
  origin: z.string().max(256).optional(),
  targetKind: z.enum(['selector', 'role', 'text', 'testId']).optional(),
  textLength: z.number().int().min(0).max(SESSION_CONTROL_LIMITS.maxTextInput).optional(),
  keyClass: z.enum(['character', 'named']).optional(),
  deltaX: z.number().int().min(-10_000).max(10_000).optional(),
  deltaY: z.number().int().min(-10_000).max(10_000).optional(),
  condition: z.enum(['domReady', 'targetVisible', 'url']).optional(),
  timeoutMs: z.number().int().min(0).max(SESSION_CONTROL_LIMITS.maxWaitMs).optional(),
}).strict();
export type SessionControlTraceParams = z.infer<typeof sessionControlTraceParamsSchema>;

export const sessionControlTraceEventSchema = z.object({
  schemaVersion: z.literal(SESSION_CONTROL_SCHEMA_VERSION),
  runId: traceIdSchema,
  attemptId: traceIdSchema,
  sessionId: traceIdSchema,
  scenarioId: traceIdSchema.optional(),
  requestId: traceIdSchema,
  timestamp: z.string().datetime(),
  action: z.enum(['metadata', 'screenshot', 'accessibilitySnapshot', 'navigate', 'click', 'type', 'key', 'scroll', 'waitForCondition', 'requestStop']),
  params: sessionControlTraceParamsSchema,
  outcome: z.enum(['completed', 'failed', 'denied']),
  errorCode: sessionControlErrorCodeSchema.optional(),
  /** Opaque reference to canonical evidence (#220/#330); the event never embeds the content. */
  evidenceRef: z.string().min(1).max(1_024).optional(),
}).strict();
export type SessionControlTraceEvent = z.infer<typeof sessionControlTraceEventSchema>;

function safeOrigin(value: string): string | undefined {
  // No `URL` global in this package's lib (it is runtime-neutral), so match the origin directly.
  const match = /^(https?):\/\/([^\s/?#@]+)(?:[/?#]|$)/i.exec(value);
  if (!match) return undefined;
  return `${match[1]!.toLowerCase()}://${match[2]!.toLowerCase()}`.slice(0, 256);
}

/** Reduces an action to bounded, non-sensitive trace parameters. */
export function sanitizeSessionControlActionForTrace(action: SessionControlAction): SessionControlTraceParams {
  switch (action.type) {
    case 'metadata':
    case 'requestStop':
      return {};
    case 'screenshot': return { format: action.format, fullPage: action.fullPage };
    case 'accessibilitySnapshot': return { maxNodes: action.maxNodes };
    case 'navigate': { const origin = safeOrigin(action.url); return { ...(origin ? { origin } : {}), timeoutMs: action.timeoutMs }; }
    case 'click': return { targetKind: action.target.kind, timeoutMs: action.timeoutMs };
    case 'type': return { targetKind: action.target.kind, textLength: action.text.length, timeoutMs: action.timeoutMs };
    case 'key': return { keyClass: action.key.length === 1 ? 'character' : 'named' };
    case 'scroll': return { deltaX: action.deltaX, deltaY: action.deltaY };
    case 'waitForCondition': return { condition: action.condition, ...(action.target ? { targetKind: action.target.kind } : {}), timeoutMs: action.timeoutMs };
  }
}
