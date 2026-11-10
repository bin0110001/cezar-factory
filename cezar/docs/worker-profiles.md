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
