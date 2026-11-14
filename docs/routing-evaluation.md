# Routing evaluation

Evaluated on 2026-10-03 after the live local utility and OpenHands smoke
tests. The Factory has evidence for bounded local classification/summarization
jobs and a deterministic provider boundary for coding jobs, but it does not
yet have comparable subscription-agent success data: GitHub authentication and
Codex/Claude subscriptions are not connected.

The current deterministic routing policy is therefore justified. It keeps
bounded utility jobs local, sends implementation to the selected execution
provider, and records the selected worker without adding a learned router or
confidence-based fallback. Revisit sophisticated routing after premium-agent
comparisons exist.

## Historical dataset and comparison (#137)

Read-only evidence tooling; it changes no live routing.

1. `pwsh scripts/build-routing-dataset.ps1 -RunsPath runs.jsonl [-EventsPath events.jsonl] -OutPath dataset.json`
   builds the dataset (`schemas/routing-dataset.schema.json`, `schemaVersion` 1). Run records and routing events
   (`schemas/routing-event.schema.json`) are joined by `runId`. Only allow-listed fields are kept (category, model
   family/model, tier, subscription alias, attempts, duration, validation, accepted, merged, tokens, cost); prompts,
   source, logs and credentials are never copied. Records are ordered by `runId` and no timestamp is written, so the
   same input gives byte-identical output. Keep outputs under `.factory/evaluations/` (not tracked).
2. `pwsh scripts/report-routing-evaluation.ps1 -DatasetPath dataset.json -OutPath report.json` reports, per model, tier
   (#92) and subscription alias (#89–#93): runs, attempts, retries, accepted and merged changes, duration, and
   **effective cost per accepted change** = total cost of every attempt (retries included) ÷ accepted changes.
3. Missing telemetry (tokens, subscription cost, quota) is the string `unknown`. It is never estimated and never read as
   zero: one run without cost makes its group's cost `unknown`. Subscription CLIs do not expose API cost, so `unknown`
   is expected there. Groups below `-MinSample` (default 5) runs are marked `lowSample`; do not act on them.
4. Accepted/merged outcomes come from GitHub and run records (#127; #136 reliability analytics can replace the adapter
   later), not from trace completeness.

### Deterministic rule proposal (not applied)

- Keep the current tier rules. Propose a change only when two tiers each have at least `MinSample` runs with known cost
  for the same issue category, and one has a lower effective cost per accepted change with a merged rate no worse.
- A proposal is a written, reviewed edit to the routing rule table; nothing is learned or switched automatically, and
  there is no confidence-based fallback.
- Experiments are controlled opt-in: named issue categories, a fixed run cap, a fixed end date, one variable changed,
  and an owner who reads the report before any rule moves. No unbounded experimentation.

### Optional Langfuse linkage

Disabled by default and not required. Once telemetry coverage is proven (#129), `runId` may be used to link traces,
datasets and annotations in Langfuse. Outcome metrics always derive from GitHub/#127/#136 data.
