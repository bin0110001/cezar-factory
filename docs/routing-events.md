# Routing events

Contract for routing observability (#94, delivered by #314). Code lives in
`cezar/packages/cezar/src/server/routing-events/`; the JSON schema is `schemas/routing-event.schema.json`
(draft-07, `additionalProperties: false`, mirrored by a strict zod schema in `event.ts`).

## Event

Required: `schemaVersion` (1), `timestamp`, `sequence` (integer >= 1, store-assigned), `attempt` (>= 1), `state`
(`queued | capacity-blocked | routed | running | rate-limited | retried | completed`).
Optional: `eventId`, `runId`, `attemptId`, `traceId`, `selected {model, tier, subscriptionAlias}`,
`decisionReason`, `deferralReason`, `quotaSnapshot {limit, used, remaining, ratio, resetAt}`.

## Store

`RoutingEventStore` is append-only JSONL: it exposes `append` and `read` only. One serialized in-process
writer assigns a strictly monotonic `sequence` (recovered from the file on open), validates, appends and
fsyncs. A torn trailing line is skipped on read and healed before the next append. Cross-process writers are
out of scope.

## Redaction

`redactEvent` builds events by allow-list, so prompts, messages, headers, env and any unknown field are dropped.
Free-text fields (and model/alias values) are scrubbed for bearer/basic tokens, `sk-`/`ghp_`/Slack/AWS keys,
JWTs and `key=value` secrets. `redactLogPayload` / `safeLogger` apply the same to structured log lines
(sensitive key names are masked entirely).

## Emit

`emitRoutingEvent(input)` redacts, then calls each registered sink (`setRoutingEventSinks`); the store
(`storeSink`) is just one sink. Sink failures go to an error handler and never throw into routing. #92/#93
call `emitRoutingEvent` without importing the store.

## Relation to #126/#127/#128

`runId`, `attemptId`, `eventId` and `traceId` are opaque strings owned by the run-ID contract (#126), ledger
(#127) and trace context (#128). This store is a thin sink that #127 can replace; it is not a second ledger.
