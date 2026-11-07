import { z } from 'zod';

/** Routing event contract (#94). Mirrors schemas/routing-event.schema.json; keep both in sync. */
export const ROUTING_STATES = ['queued', 'capacity-blocked', 'routed', 'running', 'rate-limited', 'retried', 'completed'] as const;
export type RoutingState = (typeof ROUTING_STATES)[number];

const id = z.string().min(1).max(128);

export const routingEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  eventId: id.optional(),
  runId: id.optional(),
  attemptId: id.optional(),
  traceId: id.optional(),
  timestamp: z.iso.datetime({ offset: true }),
  sequence: z.number().int().min(1),
  attempt: z.number().int().min(1),
  state: z.enum(ROUTING_STATES),
  selected: z.strictObject({
    model: z.string().max(128).optional(),
    tier: z.string().max(64).optional(),
    subscriptionAlias: z.string().max(128).optional(),
  }).optional(),
  decisionReason: z.string().max(512).optional(),
  deferralReason: z.string().max(512).optional(),
  quotaSnapshot: z.strictObject({
    limit: z.number().min(0).optional(),
    used: z.number().min(0).optional(),
    remaining: z.number().min(0).optional(),
    ratio: z.number().min(0).optional(),
    resetAt: z.iso.datetime({ offset: true }).optional(),
  }).optional(),
});

export type RoutingEvent = z.infer<typeof routingEventSchema>;
/** What a producer supplies; the store assigns schemaVersion, timestamp (if absent) and sequence. */
export type RoutingEventInput = Record<string, unknown>;

export function parseRoutingEvent(input: unknown): { ok: true; event: RoutingEvent } | { ok: false; errors: string[] } {
  const r = routingEventSchema.safeParse(input);
  return r.success ? { ok: true, event: r.data } : { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
