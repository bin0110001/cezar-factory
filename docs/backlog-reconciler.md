# Backlog reconciler

`scripts/reconcile-backlog.ps1` is read-only. It accepts a compact GitHub-state snapshot and emits `.factory/backlog-reconciliation.json`; it does not label, dispatch, or mutate GitHub.

Its deterministic ordering is: highest numeric `priority`, dependency-ready before non-ready, oldest `createdAt`, then lowest issue number. An issue must have exactly one `factory:*` label and no blocker, human gate, or unexpired lease. The batch and project-concurrency caps both bound the proposed list.

`scripts/lease.ps1` writes a compact, machine-readable marker comment to the GitHub issue. It records owner, creation, expiry, and release time; same-owner creation and release are idempotent, while a different owner is refused until expiry. Dispatch remains off until the dry-run and live read-only external gates in the marching orders have evidence.
