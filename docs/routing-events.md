# Routing events

Contract for routing observability (#94, delivered by #314). Code lives in
`cezar/packages/cezar/src/server/routing-events/`; the JSON schema is `schemas/routing-event.schema.json`
(draft-07, `additionalProperties: false`, mirrored by a strict zod schema in `event.ts`).

## Event

Required: `schemaVersion` (1), `timestamp`, `sequence` (integer >= 1, store-assigned), `attempt` (>= 1), `state`
(`queued | capacity-blocked | routed | running | rate-limited | retried | completed | failed | cancelled`).
Optional: `eventId`, `runId`, `attemptId`, `traceId`, `selected {model, tier, subscriptionAlias}`,
`decisionReason`, `deferralReason`, `fallback`, `forecastConfidence` (0–1),
`quotaSnapshot {limit, used, remaining, ratio, resetAt}`.

## Metrics projection (#316)

`computeRoutingMetrics(events)` is a pure, storage-agnostic projection over redacted event histories. It reports
observed quota utilization, capacity-blocked durations, explicitly marked fallback frequency, terminal success
rates by tier (completed and failed attempts; cancellations are not treated as successes or failures), and reported forecast confidence. Each numeric metric includes its sample count and returns
`value: null` when no supporting observations exist. Blocked intervals without a following event are censored;
events without run/attempt identity cannot contribute to duration or terminal outcome metrics. Forecast confidence
is only averaged when a producer supplies it; it is not inferred from quota snapshots. The JSONL sink remains
replaceable by #127's ledger adapter; this module adds no storage.

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

## Task timeline (#315)

`buildTaskTimeline(events, {runId?, limit?})` is a pure read-side projection over persisted events (no new
storage). It re-redacts at the read boundary, orders strictly by persisted `sequence` (not timestamps or arrival
order), drops duplicates, other runs and malformed events, groups entries by attempt, and keeps the last `limit`
entries (default 500, `truncated` flags it). `explainDecision` reports the latest routed/delayed decision with its
recorded reason, tier and quota snapshot; when nothing was recorded it says `unknown` or `not recorded` rather
than inferring a reason.
