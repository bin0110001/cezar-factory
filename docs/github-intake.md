# GitHub issue intake and reconciliation

Cezar discovers GitHub issues by bounded polling (there is no webhook path). Design:
`cezar-github-issue-intake-reconciliation.md`; tracking epic #222.

All settings are keys of an automation's `filters` object (see the definition reference in
`cezar/packages/cezar/src/automations/prompts.ts`):

| Key | Effect |
|---|---|
| `maxRecords` | Issues/events examined per poll (existing; 1-100). |
| `maxAdmissionsPerCycle` | New issue launches per poll turn. The rest stay durably deferred and run later, highest `priority:<n>` label first. Deferred receipts are admitted before new ones. |
| `fullReconcileHours` | `issue.labeled` only. Every N hours also list OPEN issues still carrying a watched label and recover labelings the cursor missed. Event ids match the normal poll, so receipts deduplicate; `lastReconcileAt` / `lastReconcileRecovered` are kept in runtime state. A dry-run preview always reconciles and launches nothing. |
| `pollJitterSeconds` | Random delay added to each next poll time. |

Always on: pre-admission re-read (a closed issue, or one that lost the triggering label or no
longer matches the filters, stays deferred with a `no-longer-eligible` reason until it is
eligible again); exponential poll backoff, floored at 15 minutes for rate-limit errors; polling
and mutation leases so concurrent workers cannot corrupt cursors or receipts.

## Operating

- Why has an issue not run? Read its receipt: `deferred` plus `deferReason` (`admission-cap`,
  `no-longer-eligible`, `revalidation-failed`, or a dependency blocker).
- Dry run: preview the automation (`cez automation` preview); it reports candidates, including
  reconciliation recoveries, without launching or persisting anything.

## Not yet built (open child issues)

Repository fairness and quota-aware deferral (#225) and recovery-skill retirement with a soak test (#228)
remain open. Webhooks are intentionally out of scope. The Issue intake card (health, last
reconcile, admission limit, waiting issues with reason codes) is on each GitHub automation's log
page. Until #228, the
recovery skill stays as a diagnostic fallback and must not be given independent dispatch authority.

## Fairness and capacity (design decision, recorded as the safest reversible assumption)

- **Repository fairness** comes from the workspace scheduler's single timer: it always fires the
  longest-overdue automation across all projects, and each check advances that automation's own
  `nextCheckAt`, so a busy repository cannot monopolize polling (regression test in
  `scheduler.test.ts`). Per-automation `maxAdmissionsPerCycle` bounds each repository's share of
  new launches per turn. No separate weighting layer is added; revisit if weights are needed.
- **Capacity / quota**: admitted launches queue in the existing run manager and workspace
  semaphore, so a full agent or model tier delays execution but never drops the candidate (the
  receipt stays `launched` with a queued run, or `deferred` while an admission check fails).
