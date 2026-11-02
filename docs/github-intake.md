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

Webhook ingestion (#223), repository fairness and quota-aware deferral (#225), the Issue Intake
UI (#227), and recovery-skill retirement with a soak test (#228) remain open. Until #228, the
recovery skill stays as a diagnostic fallback and must not be given independent dispatch authority.
