# Backlog reconciler

`[factory] backlog-reconciliation` is the on-demand entry point. It is a
paused scheduled automation so it does not run on a timer; `cez automation run
<id>` queues one run. `workflows/backlog-reconciliation.yaml` owns both script
calls: it collects the snapshot with `scripts/collect-backlog-snapshot.ps1`,
then invokes `scripts/reconcile-backlog.ps1` with `-DryRun` and both caps set
to one. The final report reads only `.factory/backlog-reconciliation.json`.

The collector reads open and closed issue state through `gh`, but writes only
the open issues to `.factory/github-issues.json`. It converts lifecycle labels,
numeric `priority:<n>` labels, dependencies named in issue body lines, and the
latest GitHub-visible Factory lease marker into the compact reconciler input.
An unknown or open dependency is not marked ready. A malformed lease marker
stops collection instead of silently ignoring a potentially active claim.
The collector also stops when GitHub returns 1,000 issues, the CLI's maximum
page size, because that can indicate a truncated snapshot.

`scripts/reconcile-backlog.ps1` remains read-only by default. It accepts a
compact GitHub-state snapshot and emits `.factory/backlog-reconciliation.json`.

Its deterministic ordering is: highest numeric `priority`, dependency-ready before non-ready, oldest `createdAt`, then lowest issue number. An issue must have exactly one `factory:*` label and no blocker, human gate, or unexpired lease. The batch and project-concurrency caps both bound the proposed list.

`scripts/lease.ps1` writes a compact, machine-readable marker comment to the GitHub issue. It records owner, creation, expiry, and release time; same-owner creation and release are idempotent, while a different owner is refused until expiry. Dispatch is opt-in only with `-Dispatch -LeaseOwner`; the reconciler claims each selected issue before emitting a bounded `leased-awaiting-dispatch` record. A caller must provide the actual Cezar dispatch integration separately. `-DryRun` never claims issues.
