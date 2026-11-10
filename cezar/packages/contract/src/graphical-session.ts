import { z } from 'zod';

export const GRAPHICAL_SESSION_SCHEMA_VERSION = 1 as const;
export const GRAPHICAL_SESSION_LIMITS = {
  maxWidth: 16_384,
  maxHeight: 16_384,
  maxDpi: 1_200,
  maxRuntimeMs: 3_600_000,
  maxFeatures: 64,
  maxEvidenceKinds: 8,
} as const;

export const graphicalSessionModeSchema = z.enum(['headless', 'offscreen-rendered', 'displayed']);
export const graphicalDisplayBackendSchema = z.enum(['auto', 'x11', 'wayland', 'native']);
export const graphicalRendererSchema = z.enum(['software', 'opengl', 'vulkan']);
export const graphicalEvidenceKindSchema = z.enum(['screenshot', 'video', 'trace', 'metadata']);

const displaySchema = z.object({
  backend: graphicalDisplayBackendSchema,
  width: z.number().int().min(320).max(GRAPHICAL_SESSION_LIMITS.maxWidth),
  height: z.number().int().min(240).max(GRAPHICAL_SESSION_LIMITS.maxHeight),
  dpi: z.number().min(48).max(GRAPHICAL_SESSION_LIMITS.maxDpi),
}).strict();

const rendererSchema = z.object({
  requirement: graphicalRendererSchema,
  gpuRequired: z.boolean().default(false),
  features: z.array(z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/)).max(GRAPHICAL_SESSION_LIMITS.maxFeatures).default([]),
}).strict();

export const graphicalSessionRequestSchema = z.object({
  schemaVersion: z.literal(GRAPHICAL_SESSION_SCHEMA_VERSION),
  mode: graphicalSessionModeSchema,
  display: displaySchema.optional(),
  renderer: rendererSchema.optional(),
  appEntryPoint: z.string().min(1).max(1_024).refine((value) => {
    const normalized = value.replaceAll('\\', '/');
    return !normalized.startsWith('/') && !/^[a-zA-Z]:/.test(normalized)
      && normalized.split('/').every((part) => part !== '..' && part !== '.');
  }, 'appEntryPoint must be a normalized project-relative path'),
  timeoutMs: z.number().int().min(100).max(GRAPHICAL_SESSION_LIMITS.maxRuntimeMs).default(60_000),
  permittedEvidence: z.array(graphicalEvidenceKindSchema).max(GRAPHICAL_SESSION_LIMITS.maxEvidenceKinds).default(['metadata']),
}).strict().superRefine((request, ctx) => {
  if (request.mode === 'displayed' && !request.display) {
    ctx.addIssue({ code: 'custom', path: ['display'], message: 'displayed mode requires a session-local display specification' });
  }
  if (request.mode !== 'displayed' && request.display) {
    ctx.addIssue({ code: 'custom', path: ['display'], message: 'display is only valid for displayed mode' });
  }
  if (request.mode === 'headless' && request.renderer) {
    ctx.addIssue({ code: 'custom', path: ['renderer'], message: 'headless mode does not create a rendering context' });
  }
  if (request.mode !== 'headless' && !request.renderer) {
    ctx.addIssue({ code: 'custom', path: ['renderer'], message: 'rendered modes require an explicit renderer requirement' });
  }
});
export type GraphicalSessionRequest = z.infer<typeof graphicalSessionRequestSchema>;

export const graphicalSessionStatusSchema = z.enum([
  'starting', 'ready', 'running', 'completed', 'failed', 'cancelled', 'disconnected',
]);
export const graphicalSessionFailureReasonSchema = z.enum([
  'missing_display', 'unsupported_renderer', 'stale_capability', 'gpu_unavailable', 'gpu_reset',
  'startup_timeout', 'orphaned_child', 'hung_application', 'display_collision', 'stale_lease',
  'worker_disconnected', 'cancelled', 'resource_exhausted',
]);

export const graphicalSessionOutcomeSchema = z.object({
  schemaVersion: z.literal(GRAPHICAL_SESSION_SCHEMA_VERSION),
  sessionId: z.string().min(1).max(128),
  status: graphicalSessionStatusSchema,
  reason: graphicalSessionFailureReasonSchema.optional(),
}).strict().superRefine((outcome, ctx) => {
  if (['failed', 'cancelled', 'disconnected'].includes(outcome.status) && !outcome.reason) {
    ctx.addIssue({ code: 'custom', path: ['reason'], message: 'terminal non-success outcomes require a typed reason' });
  }
  if (['starting', 'ready', 'running', 'completed'].includes(outcome.status) && outcome.reason) {
    ctx.addIssue({ code: 'custom', path: ['reason'], message: 'successful or active outcomes cannot carry a failure reason' });
  }
});
export type GraphicalSessionOutcome = z.infer<typeof graphicalSessionOutcomeSchema>;

/** A missing request preserves legacy execution; only trusted server capability enables a request. */
export function graphicalSessionRequestAllowed(enabled: boolean, request: GraphicalSessionRequest | undefined): boolean {
  return request === undefined || enabled;
}
