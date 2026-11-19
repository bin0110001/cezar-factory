# Generic worker profiles

Worker inventories, profile templates, and job requirements use
`@open-mercato/cezar-contract` version 1 schemas. They extend the existing
`#112` worker capability descriptor and `#198` resource-lock admission path.
Workers that only have the legacy capability descriptor continue to schedule
jobs that do not request a profile.

## Inventory and freshness

An inventory reports OS, architecture, executors, installed runtime versions,
resource quantities, isolation level, network zones, storage/accessibility
features, profile tags, and namespaced capability probes. Each probe is marked
`validated`, `unknown`, or `failed`; unknown and failed probes never match a
requirement. `observedAt` plus `freshForMs` sets its expiry. Profiles and request
schemas reject unknown versions and unknown fields.

Capability observations are evidence, not grants. The worker inventory cannot
grant project capabilities or select its own privileged profiles. Trusted
configuration attaches profiles and resolves their policy. Overrides can reduce
allowed capabilities, network zones, or concurrency, and can add stricter
requirements; attempts to widen those limits or replace a profile requirement
are rejected.

`refreshGraphicalWorkerInventory` runs bounded Windows/Linux probes and records
validated, unknown, or failed observations. It reports detected drivers, GPU
counts, renderer/API support, virtual-display tooling, and Godot versions where
the host tools can verify them. VRAM, safe simultaneous sessions, and capture
remain unknown unless an injected host probe validates them. Unsupported Windows
rendering backends are explicitly unknown, so a backend request stays
unschedulable. Resource or runtime claims that a refresh cannot verify are
removed instead of carried forward. Workers can use this helper at enrollment
and provide it as `refreshInventory`; the scheduler invokes that callback when
the snapshot expires and keeps the worker stale if probing fails.

Built-in templates cover general compute, GUI, lightweight network peer, and
read-only asset access. Profiles can be composed: hard requirements tighten,
network zones intersect, concurrency takes the lowest limit, and policy grants
combine only across trusted selected templates. Job requests may add requirements,
affinity/anti-affinity, locality preference, priority metadata, and shared or
exclusive resource leases. The existing lock manager reserves per-worker
concurrency slots atomically and continues to serialize exclusive display leases.

## Local inspection

The CLI lists built-in profile names and can summarize a supplied inventory file:

```text
cezar worker-profiles list
cezar worker-profiles inspect ./worker-inventory.json
```

Inspection prints OS/architecture, resource field names, runtime names, profile
tags, and counts of validated/unknown/failed probes. It omits observed capability
values and arbitrary runtime metadata. The command is read-only; it does not enroll
workers or update inventory.

## Scheduling results

Profile matching returns a deterministic preference score for local affinity or
typed reasons for stale inventory, incompatible requirements, policy denial, or
concurrency saturation. A scheduled profile job reserves one of the worker's
bounded concurrency slots together with all requested resource leases under the
existing `ResourceLockManager`, so concurrent admissions cannot claim the same
slot or exclusive display.

The Windows/Linux mock-agent integration suite exercises this admission path
without connecting to a real worker. Its start/release gates verify that jobs on
independent displays overlap, jobs sharing a display wait for the lease, missing
OS/GUI capabilities fail closed, and cancellation releases the worker lease.
Run it from the Cezar workspace with:

```text
npm test -- --run packages/cezar/src/server/verification/remote-agent.integration.test.ts
```

The test is platform-neutral and should be run on each supported host; it does
not claim coverage for distributed transport or a worker-environment janitor.

## Worker operations read model (#219, first slice)

`server/verification/worker-read-model.ts` is a pure projection (no store, no
scheduler) for the existing Control Center worker view. It derives a fail-closed
status from heartbeat age: `healthy` only with a fresh heartbeat; `stale`,
`offline`, and never-seen `unknown` are never healthy; `revoked` always wins and
`draining`/`quarantined` apply to live workers. Capacity counts only `running`
attempts, so canceled and released attempts free capacity consistently in the
worker and run views. Pages are cursor-paginated (max 100), errors are redacted
of credentials and host paths and truncated, and `explainScheduling` is a
side-effect-free dry run that lists why each worker is ineligible.

Still open (needs the open #70/#108/#127/#128/#135 services): HTTP routes and UI, trace correlation, and graphical session preview.

## Scenario operations and operator actions (#219, second slice)

`server/verification/scenario-operations.ts` adds a pure per-scenario projection:
per-shard/role partitions, coverage completeness (a scenario is `pass` only when
every expected role finished with all required evidence), infra-failure vs
assertion-failure, queued reasons (from `explainScheduling`), missing evidence,
redacted errors and stable trace ids (diagnostic only, never evidence). A finished
partition without a verdict is an infra failure, never a pass; canceled/released
partitions show as `canceled`.

`OperatorActionGuard` wraps operator mutations (enroll-link, revoke, drain,
undrain, quarantine, cancel, retry, set-profile, schedule-dry-run). It enforces a
permission per action, idempotency keys (replays do not re-apply; key reuse for a
different request is rejected), retry eligibility (infra failure or canceled only)
and records an audit entry for every outcome. Mutations are delegated to the
existing controller API through the `apply` callback.

Still open: HTTP routes/UI and graphical session preview (blocked on #108/#127/#128/#135).

## Run verification view (#219, third slice)

`server/verification/run-verification-view.ts` composes the scenario projection into
the existing run page model: a start-ordered per-shard/role timeline (a running
partition on a stale/offline worker is flagged as disconnected, never healthy),
abstract topology requirements with a host-count check (`unknown` when not
determinable), failure class (infra/assertion/both), a performance baseline from
passing runs only (`regression` stays `unknown` below 3 samples), the last
successful run, permission-scoped artifact links (max 50 visible, hidden count
reported, no media bytes) and trace ids marked `authoritative: false`.

## Graphical sessions, preview and artifacts (#219, sixth slice)

`server/verification/graphical-session-view.ts` adds pure projections and guards (no
streaming transport, store or media bytes; live streaming stays with #108/#127/#128/#135):

- **Session rows**: display/renderer/browser fingerprint (host paths and secrets redacted),
  run/attempt/scenario/role, owner, state, reserved resources, startup duration and last frame.
  `stream` is `live` only with a fresh frame from a running, connected session; otherwise
  `stale` or `unknown`, never healthy.
- **Preview**: opt-in (`preview:view`), authenticated, always `view-only`, FPS and bandwidth
  clamped to `PREVIEW_LIMITS`; unavailable unless the stream is live.
- **Takeover**: `TakeoverGuard` requires the distinct `takeover:grant` permission plus an
  unexpired grant bound to the actor and session. Agent input is suspended while active;
  request, deny, grant, suspend, release, resume and expire are each audited (#329).
- **Artifact browsing**: `listArtifacts` is cursor-paginated (max 50), permission-scoped,
  retention-aware and name-redacted; `authorizeDownload` returns only an id for the canonical
  artifact layer. Out-of-scope artifacts report `forbidden` or `not-found`.
- **Checkpoints**: the run view (schema version 2, additive) carries a per-node checkpoint
  timeline marking `missing` and `disconnected` captures, with warnings. Runs without
  checkpoints get an empty list; everything else is unchanged.

Still open: HTTP routes/UI.

## Operator controls (#219, slice 5)

`server/verification/operator-controls.ts` binds the `OperatorActionGuard` to the
controller. Actor and permissions come from the authenticated principal
(`viewer`, `operator`, `admin` roles mapped to permissions server-side; unknown
roles grant nothing); permissions in a request body are ignored. Request and
response payloads carry `schemaVersion: 1`.

- Actions: enroll-link, revoke, drain, undrain, quarantine, cancel,
  retry (infra-failure/canceled partitions only, outcome read server-side),
  set-profile and schedule-dry-run (read-only explanation).
- Idempotency: the same key from the same actor for the same action and target
  applies once and returns `replayed: true`; reuse for anything else is `invalid`.
- Denied, rejected and replayed requests are all audited; reasons are redacted
  (no secrets or host paths).
- Concurrency: actions on one target are serialised in arrival order, and an
  optional `expectedVersion` rejects stale targets (`invalid`, audited, not cached).
- Cancel/revoke mutate the partition state that both the worker read model
  and the run verification view project, so the two views agree on status and
  lease release. A newly enrolled worker is `unknown`, never healthy.
- Limitation: idempotency and audit are bounded in-memory (default 10 000
  entries) and are lost on restart. HTTP routes and UI controls are not yet
  mounted; this service is the contract they will call.
