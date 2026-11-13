# Changelog

## [Unreleased]

- A generic multi-worker scenario core (#217). `scripts/scenario/scenario_orchestrator.py` validates a versioned manifest of named roles, places them deterministically on workers (distinct physical hosts never downgraded, graphical controls kept as requirements), reserves all workers or none through a TTL and fencing lease store, and runs a prepare-to-terminal coordinator with role barriers, a fault policy (evidence collected, every role torn down, no orphan leases, retry only for safe infra faults) and replay and stale-fence rejection. Tested with a non-Godot echo fixture; see `docs/scenario-orchestration.md`. The authenticated transport, the #112 store adapter and the Godot pilot are not part of this change.

- The stale refresher re-triggers one `factory:ready` issue an hour instead of two (`STABILIZATION-PLAN.md` item 3.1). With the implement automations enabled, the refresher is what starts feature work from the backlog, at 170,000 to 450,000 tokens a run, and a spent Claude limit fails the maintenance run and the promotion canary. `-Limit 1` is passed in `workflows/maintenance.yaml`; the script default is unchanged.

- A fixture canary drives the issue lifecycle against a real sandbox repository (`STABILIZATION-PLAN.md` item 2.10, model-free form). `scripts/fixture-lifecycle.ps1` (workflow `factory-fixture-lifecycle`, automation `[factory] fixture lifecycle`, canary `fixture-lifecycle`) creates an issue in the private repository `bin0110001/cezar-factory-sandbox`, runs `route-state.ps1` through intake, plan, start and implement with the real `gh` and canned agent results, checks after each step that the issue holds exactly the state the lifecycle model declares, and always closes the issue afterwards. It spends no tokens and catches the live-GitHub label and comment failures that the fake `gh` cannot. It runs on every candidate that changes scripts, workflows, automations, policies or config. The agent steps themselves (plan, implement, review with a model) are still not rehearsed before production. The sandbox repository is overridable with `FACTORY_FIXTURE_REPO`.

- Cezar's scheduler lane gate and its decision states are pinned to the lifecycle policy (`STABILIZATION-PLAN.md` item 1.4f, in part). A Cezar test fails when `PRE_READY_LANE_LABELS` differs from the states the policy puts in the Inbox and Refinement lanes, or when `DECISION_STATES` differs from the policy's human states or no longer lets a person send an issue back to the resume state. Two constants are now exported for it; nothing changes at run time.

- The lifecycle policy now declares each state's backlog lane (`STABILIZATION-PLAN.md` item 1.4f, in part). Every state in the standard profile of `policies/lifecycle.json` carries a `lane`, and a Cezar test fails when the state-to-lane table in `server/backlog/migrate.ts` differs from it. Nothing changes at run time; the table stays in the server, but it can no longer drift from the policy unnoticed. Reading the lanes from the policy at run time, and the browser's lane columns, are still open.

- A check run while the container is down is retried, not failed (`STABILIZATION-PLAN.md` item 0.9, remainder). Candidate `0186a841c` was recorded as failed with `can only create exec sessions on running containers: container state improper`: the deploy of the previous merge had stopped Cezar while the promoter was about to start its suite, and `podman exec` exits 255, which the interruption rule (exit 137 or 143) did not cover. A required check that exits 255 with that message is now treated as interrupted, with the same retry budget and no breaker count. Test added.

- The router and the lifecycle model are checked against each other (`STABILIZATION-PLAN.md` item 1.4c, in part). A suite test reads `scripts/route-state.ps1` and fails when an event sets a state that none of its accepted source states reaches in `policies/lifecycle.json`, or when the model declares an exit for one of the router's events that the router cannot take. Both already agree, so nothing changes at run time; the router's own transitions stay in code, but they can no longer drift from the model unnoticed.

- Cezar's stall detector reads the Factory's lifecycle policy (`STABILIZATION-PLAN.md` item 1.4f, in part). It derives which `factory:*` labels are lifecycle states, which a person owns, and which mean work is in flight from `policies/lifecycle.json` (counting every profile, with `extends` applied) instead of three hard-coded sets, so an issue waiting at a profile-only state such as the `risk-gated` profile's `factory:design-signoff` is reported as waiting on a person and not as having no state label. With the shipped policy the derived sets are exactly the old constants (a test pins this); when the file is missing or invalid the detector uses the standard process as before. `factory:review` and `factory:changes-requested` carry `"inFlight": true` in the policy to keep their treatment. The Decisions screen and backlog lanes still keep their own lists.
- A boot-order installer for the host (`STABILIZATION-PLAN.md` item 0.11, prepared). `scripts/deploy/install-boot-order.sh` (modes `install`, `remove`, `check`) adds a systemd user drop-in that makes `container-cezar.service`, `podman-restart.service` and the `podman-compose@` template want and follow `podman-user-wait-network-online.service`. A user unit's `After=network-online.target` refers to the user manager's own stub, reached at login, so after the 2026-11-12 reboot the containers started before the host had its address and Cezar could not reach LiteLLM until every bridge container was restarted by hand. It is idempotent, owns only its own drop-in file, and restarts nothing; it has a test with a faked user manager. It has not been run on the host: that is the owner's step, and it can only be proven by the next reboot.
- A promotion canary now runs the candidate's own workflow files (`STABILIZATION-PLAN.md` item 2.11). Cezar loads a project's own `.ai/cezar/workflows` before a release's, and on the host that was a symlink to the checkout's `workflows/` (`stable`), so a change to a workflow file was first exercised by the first scheduled run after `stable` moved. The symlink was removed on the host with the owner's approval; this entry and the plan record the check and the restore command. No repository code changed.

- Three more scripts take the lifecycle states from the policy instead of their own copy of the list (`STABILIZATION-PLAN.md` item 1.4c): `reconcile-backlog.ps1`, `collect-backlog-snapshot.ps1` and `audit-backlog-labels.ps1`. The states they still name in code are transitions and routing, not lists. With a lifecycle profile that adds a state, these scripts now see it. The health workflow's start-up manifest lists the library.

- Level-triggered consumers (`STABILIZATION-PLAN.md` item 1.11). Every `issue.labeled` automation now also re-lists the open issues that still carry its label once a day (`fullReconcileHours: 24`) and recovers events the poller missed, admits one new launch per poll (`maxAdmissionsPerCycle: 1`), and looks back 30 days across up to 25 records, as intake already did. Before, the planning, investigation, review, implement and fix automations polled one record, never re-read existing labels, and lost any event that arrived while they were paused or down. The enabled planning, investigation and review automations also take existing eligible work on creation; the implement and fix automations do not, so enabling one still baselines to now and never launches the backlog. A suite test requires this of every `issue.labeled` automation.
- Lifecycle profiles and a conditional sign-off step, by configuration alone (`STABILIZATION-PLAN.md` items 1.4d and 1.4e). A profile in `policies/lifecycle.json` can now `extend` another and restate only the states that differ, and an exit can be conditional on the issue's labels (`"when": { "risk": ["risk:high"] }`). The shipped `risk-gated` profile holds a completed plan for `risk:high` work at a human `factory:design-signoff` state (owner role `tech-lead`) instead of `factory:ready`; the implement automation cannot start it until a person relabels it. `route-state.ps1` reads that from the policy, `create-labels.ps1` creates a profile's own state labels, and `FACTORY_LIFECYCLE_PROFILE` selects the profile for a project; the default process is unchanged and tested. The state table in `docs/lifecycle.md` is now rendered from the model and a suite test fails when it is stale, and every profile the policy ships must pass the soundness check.
- The start-up smoke is table-driven and covers every workflow script (`STABILIZATION-PLAN.md` items 2.4 and 2.7). It reads `workflows/*.yaml`, so each of the 53 script invocations is started as its step starts it (empty directory and home, refusing `gh`, no Cezar API, 60 second limit) and a new step is covered the day it is written; unset variables and null-array indexing now count as code defects. A new scratch-state gate creates every `.factory/<name>` path the Factory's code mentions (51 today) in a clean repository with the real `.gitignore` and requires the checkout to stay clean, with a repository that lacks the rule as the control.

- `ship-loop.ps1 -Action Health` prints the remaining GitHub API budget (`SHIP_HEALTH_GITHUB`) and warns below 500 points, because an exhausted budget makes promotion, activation and issue filing fail together and looks like a release defect (`STABILIZATION-PLAN.md` item 0.10). The plan records what was measured: one dependency-graph page costs 3 points, and the consumer is not yet attributed.

- Stop the stray commits (`STABILIZATION-PLAN.md` item 0.2). Two things were committing to `cez/<id>` branches, `main` and once the root `stable` checkout: the label-audit agent step, which committed, pushed and opened pull requests itself every hour (ended when #425 untracked its scratch file), and Cezar's end-of-run autosave, which commits whatever scratch is not ignored and is still doing so (`.factory/gh-cache/` entries and `shadow-audit.json` on the host today). Everything under `.factory/` is now ignored unless deliberately tracked (`release-reports/`, `obot-caddy-root.crt`), with a suite test, so a new scratch file cannot start a new stream of commits. Maintenance also ends with `assert-no-run-commits.ps1`, which fails a run whose own steps committed, and the agent step is told not to commit. A transient GitHub error while activating a candidate (the 20:35Z `gh repo view` failure of `5536a9b`) is now retried on the next tick like a killed check instead of being counted as a failure.
- Environment preflight and the last stall holes in the router (`STABILIZATION-PLAN.md` items 1.7, 1.8, 1.10). The promoter runs `promotion.preflight` (the model probe inside the Cezar container) before validating a candidate; a broken environment leaves the candidate `blocked` with the reason instead of validating, activating, failing a canary, rolling back and quarantining a good release, as happened twice on 2026-11-12 after a host reboot. `factory:needs-help` now requires a question: an investigation that says "architectural decision" without stating one is re-planned, a plan that is not ready must name what has to be answered, and an issue investigated three times (`max_investigations_per_issue`) stops with a "narrow, split or close" choice instead of looping. The hourly watchdog covers issue runs: implement and fix runs past six hours are cancelled and routed to `factory:investigate`, and plan, review and investigate runs past four hours are cancelled and left for the stale refresher. A failed canary's reason now carries what the failing step printed, so a GitHub server error behind "exited non-zero" is recognised as transient and the canary is retried; on 2026-11-12 an HTTP 502 while re-creating a label rolled back and quarantined a good release and opened the breaker. `create-labels.ps1`, which runs in every hourly maintenance, lists the labels once and writes only the ones that are missing or differ, and retries a server error, instead of sixteen writes an hour.
- Three more static checks and a Linux receipt (`STABILIZATION-PLAN.md` items 2.3, 2.5, 2.6 and the start of 2.4). The suite now fails on a construct that only works on Windows (`-WindowStyle`, an unguarded Windows-only environment variable, a drive-letter path, a `.cmd` shim in `scripts/`), on a Python entry point started by a workflow step or a systemd unit with a flag or command its argument parser does not define, and on a workflow script that dies on a defect in its own code when started exactly as its workflow starts it (six scripts that no other test or canary executes). Each check is proven against seeded defects. `ship-loop.ps1 -Action Validate` writes a receipt for the commit that passed the Linux suite, and `AGENTS.md` requires that validation before merging a change to scripts, tests, workflows, automations, policies or config.
- Lifecycle invariant sweep (`STABILIZATION-PLAN.md` items 1.5, 1.6, 1.9, 1.12 and more of 1.4c). The hourly maintenance workflow gains a `lifecycle-sweep` step (`scripts/sweep-lifecycle.ps1`) that checks every open issue against `policies/lifecycle.json`: exactly one state, an owner, inside its deadline. It repairs what is mechanical with an evidence comment (no state label, a `factory:ready` issue with no complexity label, a `factory:blocked` issue whose named blockers are all closed, an issue in review whose pull request conflicts with `dev`) and keeps one rolling "Factory stall report" issue for the rest (several states, blocked with no stated blocker, overdue work, draft or unlinked pull requests). What the sweep may repair is declared in the policy (`requires.otherwise`, `onUnblocked`, `onConflict`) and checked to be a legal exit. `maintain-repository.ps1`, `recover-audit-reservations.ps1` and `sync-issue-delivery.ps1` now take their state lists from the policy, a suite ratchet stops new scripts from hard-coding lifecycle states, and the maintenance scripts read `CEZ_API_URL`/`CEZ_PROJECT_ID` as well as the older `CEZAR_*` names. `docs/lifecycle.md` is corrected where it disagreed with the router.
- Promoter robustness (`STABILIZATION-PLAN.md` items 0.8, 0.9, 2.8, 2.9). A required check killed from outside (exit 137/143, as when a deploy restarted the Cezar container under a running suite on 2026-11-12) marks the candidate `interrupted` and it is validated again, up to twice, with no breaker count or issue; the promoter records a `validation-in-progress` marker and `deploy-cezar-runtime.sh` treats it as a busy Cezar and defers the restart. A canary that fails on a transient GitHub error is run once more before any rollback (`promotion.canaries.transientPattern`). A candidate with no changed paths is activated without validation instead of failing with "no required validation check matches". A candidate blocked at the evidence gate longer than `promotion.blocked.escalateSeconds` (default one hour) opens one `factory:needs-help` issue, and persistent drift is reported when it changes and then every six hours instead of on every tick. `docs/promotion-pipeline.md` gains a recovery table for each stage that can get stuck.
- Promotion `health` no longer says `ok` while promotion is stopped without failing (`STABILIZATION-PLAN.md` item 0.3). A candidate `blocked` at the evidence gate for an hour, or release drift past its grace period, is `degraded`; either lasting six hours is `stalled`. The report gains `reasons`, `blockedHours` and `driftHours`, and `ship-loop.ps1 -Action Health` prints the reasons. On 2026-11-12 every merge sat blocked at the approval gate for 13 hours, and the stable deploy had been failing since the day before, while `health` reported `ok`.
- Lifecycle as data (`STABILIZATION-PLAN.md` item 1.4a/b): `policies/lifecycle.json` defines every state of the `standard` profile with its kind, owner, exits, deadline and timeout action, and `scripts/lifecycle-lib.ps1` loads and checks it. The suite fails when a state has no owner, exit, deadline or consuming automation, or disagrees with `policies/labels.yaml`, and proves that a profile can add a technical-design step with manual sign-off by configuration alone. No behaviour change: `refresh-stale-workable.ps1` is the first script to take its state lists from the policy, and they are the same states as before.
- First batch of `STABILIZATION-PLAN.md` (the working plan for stalls and post-merge breakage). A stable deploy no longer fails forever when the container's root `stable` ref holds a commit that `origin/stable` does not contain (issue #432): `reconcile-container-git-metadata.sh` keeps the displaced commit under `refs/factory/displaced/` and continues. Intake selects a `factory:new` issue that has no type or risk label (classification infers them), and the promoter now files its failure issues with `type:bug` and `risk:medium`; before, every promoter-filed issue was silently skipped. `refresh-stale-workable.ps1` rotates by least recent activity instead of re-triggering the same two oldest issues every hour. `recover-audit-reservations.ps1` releases a stale `factory:auditing` marker that sits beside a lifecycle state, which no sweep owned. New static contract test (`tests/workflow-contract.ps1`): every PowerShell script must parse, and every workflow `command:` step must name an existing script and pass exactly its declared parameters, including mandatory ones; a missing POSIX `bash` now fails the suite instead of silently skipping the deploy shell tests.
- Set `promotion.mode` to `autonomous` (the documented default). `controlled` required an independent approved review that a solo-maintainer repository cannot produce (GitHub blocks self-approval), so every merge to `dev` stalled at the approval gate. Self-review plus passing validation now promotes; switch back to `controlled` for a Production Run.
- Map every open issue's blockers and make a stalled backlog impossible to miss. New stall detector (`GET /api/v1/dependency-graph/stalls`) classifies each open issue as running, runnable, blocked, waiting or stuck (dependency cycle, blocked by stuck work, `factory:blocked` with no open blocker, no state label, or a lane no enabled automation consumes); waiting on a person, decision or outside information is an acceptable stop. Backlog gains a "Dependency map" tab beside the board (layered graph, cycles, per-issue blockers). After every graph sync a stall guard logs and audits stuck work and dispatches the cycle-replan agent immediately instead of on the six-hour discovery pass. Fix the `CEZAR_BACKLOG_SCHEDULING=enforce` deadlock where intake, investigation and planning automations were refused for being in the Inbox/Refinement lane they exist to drain.
- Restore promotion to `stable`: slim `collect-backlog-snapshot.ps1` (open issues in full, closed issues by number and state only) so the `health` canary stops failing on truncated `gh` output, and merge `stable` back into `dev` after two label-audit bot commits made on `stable` on 2026-11-09 left it unable to fast-forward (every stable promotion since failed with HTTP 422, issue #427). Document that a candidate with an identical tree, such as a merge-only commit, has no changed paths and fails with "no required validation check matches".
- Make a failing promotion visible: failed checks keep the head and tail of their output plus a `failureLines` summary that goes into the failure reason and `[promotion]` issue, the scheduler gains a `health` command (ok, degraded, stalled), and `ship-loop.ps1` gains `-Action Health` and `-Action Validate` (the host's Linux full suite for a pushed commit, run by `ship-fix` before merging).
- Harden the repair path against the failures job debug mode exposed: add a recorded-failure replay test of the repair controller (`tests/test_factory_repair_replay.py`), a model-free `probe` phase with a `factory-repair-probe` workflow and `[factory] repair probe` promotion canary, a schema check for the backlog-label-audit proposal (a missing `considered` now fails with a contract message), untrack workflow scratch under `.factory/` with a suite guard, and fix the change-impact collector emitting non-ASCII paths in the Windows code page so the pre-commit hook passes on Windows.
- Add job debug mode (`FACTORY_JOB_DEBUG=1`, `ship-loop.ps1 -Action Run -JobDebug`): the repair controller sends its model call to the local vLLM endpoint and performs no reset, commit, push, PR, or attempt-budget use. Fix three repair-controller crashes it exposed: the task branch not being fast-forwardable to the repair base, tracked `.factory/*` scratch named in failure evidence aborting source collection, and a model request for protected scratch aborting the run instead of being dropped. `apply-backlog-label-audit.ps1` now tolerates a proposal with no `considered`/`changed`/`skipped` key.
- Add a Decisions screen to Cezarium that lists a project's issues waiting on a user decision with the question, details, and suggested paths, and answers them in place (comment plus return to `factory:needs-plan`). Agents can now attach structured `decisions` to plan, intake, and investigation results (`schemas/decision.schema.json`); the router embeds them in the escalation comment, and older free-text escalations still appear as an open question.
- Cut GitHub API usage in hourly maintenance: the delivery sync reads one open-issue listing instead of one `gh issue view` per referenced issue (closed issues cost nothing) and lists labels once instead of creating four every run, and the delivery sync, stale-workable refresh, and repository maintenance share a short-lived (default 120 s, `FACTORY_GH_CACHE_TTL_SECONDS`, 0 disables) on-disk cache of that listing that writers invalidate (`scripts/gh-cache.ps1`).
- Classify GitHub's "API rate limit already exceeded" response as an operational failure so repair jobs skip model calls during API throttling.
- Add a project-scoped reliability dashboard with evidence-backed first-pass and repair metrics, conservative failure classification, PR outcomes, trend views, and explicit missing-data coverage (#136).
- Add a GitHub issue run explorer backed by coding-run records, with bounded pagination, distinct execution states, Langfuse deep links, and issue-checked evidence downloads (#135).
- Add evidence-backed Hindsight provenance, deterministic-first recall captures, version history, and explicit supersession while keeping memory advisory (#134).
- Deploy the Langfuse v4 stack with isolated 30-day ClickHouse and event-object retention, private data services, health checks, trace links, worker correlation, an evaluation fixture, and scratch backup/upgrade guidance (#129).
- Add digest-addressed coding-run evidence blobs with configurable expiry, integrity checks, permanent ledger references, and an explicit prune command (#130).
- Record digest-bound coding attempt manifests, redact text artifacts, cap evidence storage, and expose manifest references through verification history (#130).
- Document channel-pinned runtime materialization, diagnostics, and the real-archive regression evidence for #64.
- Add W3C trace context propagation and coarse, allowlisted OTLP spans for workflow attempts (#128).
- Reconcile the contributor guide, release skills, target example, and synchronization docs with shared-checkout delivery, promotion ownership, receipt-bound migration/backout, and the guarded legacy compatibility path (#280).
- Guard legacy Factory pushes against configured active release/autodeploy locks, route shared-mode targets through automation-only sync, and record a fail-closed audit receipt gate for eventual script retirement (#279).
- Migrate installed Factory copies only from a schema-validated shadow-audit receipt. The new workflow
  binds the receipt to the project path and compares manifest and shared-source hashes in a separate
  `origin/dev` worktree. It leaves the project's checkout untouched, preserves modified files with
  review diffs, records a backout before deletions, and opens a migration PR (#278).
- Add a read-only registered-target shadow audit (`scripts/audit-shadow-copies.ps1`) with a bounded,
  schema-validated receipt, explicit unknown states for remote-only targets, and no target mutations (#277).
- Add an event retention policy (`policies/retention.yaml`, `event_retention_days`) and a prune step
  (`scripts/prune-events.ps1`) that atomically removes JSONL events older than the window, keeps newer
  and unparseable-timestamp events byte-for-byte, rejects invalid retention, and logs one JSON line.
- Add concise deduplicated failure summaries for agents (#103): `scripts/summarize-failures.ps1` groups finding records by
  finding ID with occurrence counts, identifiers and detail paths, redacts secrets and caps size with omitted counts.
- Add graphical worker operator runbook, benchmark and evidence docs (#343, part of #328); gaps are recorded
  explicitly because the runtime has not landed (`docs/graphical-worker-*.md`).
- Add the routing event contract (#314, part of #94): `schemas/routing-event.schema.json`, an append-only JSONL
  event store with strictly monotonic sequence, a pluggable emit function and an allow-list redaction layer
  (`docs/routing-events.md`).

## [0.3.66] - 2026-11-07

- Add reviewed baseline promotion (`scripts/promote-baseline.ps1`: permitted, non-author approver required,
  atomic baseline update, one hash-chained audit entry) and an anti-weakening guard
  (`scripts/check-weakening.ps1`, wired into the implement workflow) that rejects lowered thresholds,
  removed or downgraded mandatory checks, added suppressions, audit rewrites and protected-path edits.
  See `docs/baseline-promotion.md`.

- Add the performance-regression policy (`policies/performance.yaml`, schema, `docs/performance-regression.md`):
  measured-completion spans, environment-fingerprinted baselines, median/p95/absolute budgets, and a
  performance result recorded separately from the functional result (first slow attempt preserved).

- Add optional Hindsight incident memory (`scripts/hindsight/incident.py`, `incident.ps1`): a bounded,
  redacted, idempotent outbox for first-seen/resolved/reopened incident summaries and bank-scoped advisory
  recall with provenance, confidence, verified/hypothesized and stale markers. Hindsight stays advisory and
  never affects counts, status or gates; disabled/offline degrades to a warning.

## [0.3.65] - 2026-11-05

- Add the self-driving promotion pipeline (`docs/promotion-pipeline.md`): one host promoter validates each
  merged `dev` SHA with the full suite in the Cezar container, activates `dev`, runs canary automations,
  rolls back and quarantines on failure, then fast-forwards `stable` through the GitHub refs API and deploys
  it. Failures open one fingerprinted issue each and feed a circuit breaker. Autonomous and controlled
  postures are data in `config/promotion-policy.json`. Activation reads wait for a restarting Cezar, runtime
  restarts wait for an idle Cezar, and changed-file validation ignores `.factory/` runtime state.

## [0.3.64] - 2026-11-04

- Add a latest-failure repair workflow with deterministic known-operational-error
  exits, durable fingerprint and PR history, one hosted repair attempt, reviewed
  delivery, and explicit non-stable deployment configuration. Stable is excluded.

## [0.3.63] - 2026-11-04

- Preserve a missing investigation result as an explicit unknown, low-confidence
  handoff after one retry, allowing the issue to return to planning instead of
  failing the workflow on a missing artifact.

## [0.3.62] - 2026-11-03

- Add conflict-aware scheduling guidance (epic #192): the `factory-plan` skill now
  produces a Change Impact Manifest and `factory-workspace` documents the
  `cez workspace impact-predict|impact|impact-snapshot` verbs. Scheduler behavior
  is unchanged unless `CEZAR_BACKLOG_SCHEDULING` is set.

## [0.3.61] - 2026-11-02

- Make missing Factory target configuration explicit and verify that
  verification and test entry points cannot invoke live deployment tools.

## [0.3.60] - 2026-11-01

- Consolidate maintenance automations: add the daily read-only `factory-health`
  workflow (`[factory] health`) that runs the failure audit and the dry-run
  backlog reconciliation and writes a deterministic `.factory/health-report.json`
  with no agent session. It replaces `failure-audit` and `backlog-reconciliation`;
  those names remain accepted aliases in project configs, and `sync-automations`
  pauses/prunes their old automations.
- Classify collected failures deterministically (`factory-defect`, `environment`,
  `project-defect`, `unknown`) and publish only Factory defects as Factory issues.
- Retire the unused `factory-failure-audit`, `factory-intake`, and
  `factory-implement-prepare` skills (still accepted in existing configs).
- Make `factory-environment-analysis` explicitly on-demand and host-side.
## [0.3.58] - 2026-10-27

- Make the maintenance backlog-label audit deterministic: workflow command steps
  collect, validate, and prepare the audit, and the agent plus proposal step is
  skipped via typed no-work when no ambiguous candidates remain.
## [0.3.59] - 2026-10-30

- Automatically reconcile ready workspace claims after their exact reviewed PR
  merges, retain integrated claims while GitHub issue status updates are offline,
  preserve Factory-owned workflow phases outside lifecycle participation, and
  close retained adopted-workspace claims without deleting developer files;
  cap repeated post-merge validation retries and surface exhausted claims.

## [0.3.58] - 2026-10-29

- Add an offline-first SQLite workspace lifecycle CLI with transactional issue
  claims, verified Factory execution context, lease fencing, safe adoption,
  validation handoff, recovery, and cleanup safeguards.
- Integrate Factory and external-agent hooks with serialized integration and
  verified post-merge validation, bounded conflict repair/escalation, dashboard
  recovery actions and local lifecycle metrics.
- Add an asynchronous Langfuse OTLP outbox and an operator-approved Hindsight
  lesson queue with retry tracking.

## [0.3.57] - 2026-10-27

- Publish bounded Factory failure evidence to one canonical issue per project
  and normalized signature, with idempotent evidence appends, fail-closed
  deduplication, human review for ambiguous legacy issues, and a versioned
  publication receipt.

## [0.3.56] - 2026-10-18

- Retry shared Factory parity and automation reconciliation on every timer tick,
  verify host/container source and content identity, and record atomic success
  and failure receipts.

## [0.3.53] - 2026-10-18

- Gate Factory auto-merge on current-head review, clean workflow validation
  receipts, effective GitHub rules, successful required checks, and resolved
  review threads; only mark issues done after GitHub reports the PR merged.

## [0.3.50] - 2026-10-18

- Continue eligible backlog issues without per-issue scheduling or user review
  gates; reserve user input for major architectural decisions and automatically
  queue decomposed child issues.

## [0.3.48] - 2026-10-16

- Bounded and redacted local failure collection, removed bulk run enumeration
  and collector-side publication/restarts, and recorded explicit coverage
  limitations in a versioned artifact.

## [0.3.47] - 2026-10-16

- Replaced heuristic Factory test discovery with configured project validation
  adapters, bounded worktree-local receipts, and required full/verify workflow
  stages. Added the Factory source checkout's own explicit validation adapter
  configuration.

## [0.3.46] - 2026-10-16

- Reject contradictory implementation success results and define versioned,
  head-bound workflow validation receipts separately from agent handoffs.

## [0.3.45] - 2026-10-16

- Made plan, implementation, fix, review, and investigation result examples
  valid against their schemas; kept Factory script execution in workflow
  commands and completed startup script preflight lists.

## [0.3.44] - 2026-10-11

- Added expiring, Cezar-aware recovery for abandoned `factory:auditing`
  reservations, with durable reservation markers, recovery evidence, and
  regression coverage.

## [0.3.43] - 2026-10-11

- Added a workflow-owned post-implementation guard that ensures successful PRs
  contain a GitHub closing reference for their Factory issue.

## [0.3.42] - 2026-10-09

- One place to update: Cezar now loads Factory workflows and skills directly from the mounted
  Factory checkout (`CEZ_SHARED_WORKFLOWS_DIRS` / `CEZ_SHARED_SKILL_DIRS`; project files still win
  by name). `scripts/release/promote-stable.ps1` moves `origin/stable` only after the full test
  suite passes, and `scripts/deploy/factory-autodeploy.sh` (systemd timer) fast-forwards the
  Bazzite checkout to it and reconciles automations. `scripts/migrate-to-shared.ps1` removes a
  project's installed copy. See `docs/shared-factory.md`.
- Fixed the test suite hanging (`reconcile-backlog.ps1` assigned the automatic `$input` variable)
  and the fixtures copying the vendored `cezar/` tree.

## [0.3.41] - 2026-10-09

- `GODOT_BIN` in the Cezar image is now a per-project version selector backed by a persistent
  `godot-versions` volume; Godot versions install on demand (checksum-verified), so adopting a
  new release needs no image rebuild or container restart. See `docs/godot-upgrades.md`.
- Added the `factory-godot-upgrade` workflow, skill, and daily `[factory] godot-upgrade`
  automation: detect a new stable Godot, pin it on a branch, run the project's Godot tests,
  let the agent fix regressions, and open an auto-merge PR. Enabled with `features.godot_upgrade`
  or, for remote-only targets, `"projectType": "godot"` in the target registry.

## [0.3.40] - 2026-10-09

- Release synchronization now emits JSON-line status records and persists them
  under `.factory/release-reports/`. A blocked normal managed update is marked
  `forceRefreshRequired`, with the exact recovery command, instead of looking
  like an ambiguous failed push.

## [0.3.39] - 2026-10-09

- Startup now accepts the comma-delimited `RequiredScripts` form emitted by
  Cezar workflow commands, validates each script separately, and records the
  normalized list in its receipt. This prevents a valid maintenance runtime
  from failing preflight as though three script names were one file.

## [0.3.38] - 2026-10-09

- Added an explicit `-ForceManagedRefresh` release path for a project whose
  installed Factory manifest has drifted beyond the normal safe updater. It
  archives the current Factory layer, replaces only Factory-owned files, then
  reinstalls and verifies the pinned source. This is an operator-authorized
  recovery mode; normal releases still refuse ambiguous or modified files.

## [0.3.37] - 2026-10-08

- Restored `factory-implement-prepare` as a no-op compatibility skill so
  projects pinned before 0.3.36 can synchronize their Factory installation.
  Preparation is owned by the `implement` workflow; the compatibility skill
  must not run Factory scripts or be added to new project configurations.

## [0.3.36] - 2026-10-08

- Workflows now own every script. `implement` and `fix-review` run
  `prepare-implementation.ps1` and `route-state.ps1 -Event start` as command
  steps (new `-Task "{{task}}"` parameter parses the issue number); the model
  is no longer told to run Factory scripts. The `factory-implement-prepare`
  skill is removed.
- Maintenance no longer selects or routes intake issues; it runs only the
  label audit, stale-workable refresh, and repository sweep. Intake remains the
  `[factory] intake` automation.
- `review` now uses `$FACTORY_RUNTIME_ROOT` scripts and startup checks like the
  other workflows. Skills and AGENTS.md state that agents queue an automation
  and stop rather than inspecting or recreating its work.
- `tests/run-tests.ps1` fails when a skill or workflow prompt tells the model
  to run a Factory script.

## [0.3.35]

- Made scheduled maintenance deterministic: scripts now perform repository
  lifecycle hygiene and stale-issue summaries, numeric runner arguments are
  removed, and the model is limited to the existing capped ambiguous-label
  review.

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Cezar's stall detector reads the Factory's lifecycle policy (`STABILIZATION-PLAN.md` item 1.4f, in part). It derives which `factory:*` labels are lifecycle states, which a person owns, and which mean work is in flight from `policies/lifecycle.json` (counting every profile, with `extends` applied) instead of three hard-coded sets, so an issue waiting at a profile-only state such as the `risk-gated` profile's `factory:design-signoff` is reported as waiting on a person and not as having no state label. With the shipped policy the derived sets are exactly the old constants (a test pins this); when the file is missing or invalid the detector uses the standard process as before. `factory:review` and `factory:changes-requested` carry `"inFlight": true` in the policy to keep their treatment. The Decisions screen and backlog lanes still keep their own lists.
### Fixed
- Combined backlog-label normalization, stale-workable refresh, existing-issue
  intake, and the repository maintenance sweep into one bounded hourly
  maintenance workflow and automation.
- Added an implementation preparation step that fetches the selected issue
  through authenticated `gh`, captures applicable instructions and repository
  tooling, and hands the agent a worktree-local context artifact before code
  changes begin.
- Added a shared startup preflight to every Factory workflow. It validates the
  registered runtime, required tools, and workflow-specific scripts before the
  first agent or command step and records a bounded worktree-local receipt.

## [0.3.34]

### Added
- Added a shared startup preflight to every Factory workflow. It validates the
  registered runtime, required tools, and workflow-specific scripts before the
  first agent or command step and records a bounded worktree-local receipt.

## [0.3.33]

### Added
- Added the preparation-first implementation workflow and bounded context
  generation script.

### Fixed
- Made lifecycle routing backward-compatible with older installed policy layers
  that lack the `complexity` section; routing now uses the canonical complexity
  taxonomy instead of failing and sending the agent into discovery loops.
- Added a complexity guard to lifecycle worker selection so medium and large
  implementation issues cannot be routed to the bounded local worker, even
  when stale `agent:local` labels are present.
- Updated lifecycle and Cezar integration documentation to distinguish
  advisory local jobs from implementation automation.
- Routed medium implementation and review-fix automation through the configured
  Factory gateway model instead of the unavailable Terra pin, which allowed
  runs to start checks without producing an implementation result artifact.
- Hardened the implementation step against command drift: it now requires
  authenticated issue/manual reads, forbids speculative child dispatch and
  machine-specific paths, and stops with a structured blocker after bounded
  command recovery instead of wandering through unrelated discovery attempts.
- Allowed successful implementation results to set `documentationUpdated: false`
  when documentation was reviewed and no update was required; previously this
  caused otherwise valid implementation runs to fail validation and retry.
- Replaced unavailable `FACTORY_RUNTIME_ROOT` command paths with the mounted
  `/projects/cezar-factory` path across intake, planning, implementation,
  review-fix, and investigation workflows so validated results can route to
  the next lifecycle state.
- Made the scheduled refresh check use the mounted `/projects/cezar-factory`
  runtime path because Cezar check steps do not expand `FACTORY_RUNTIME_ROOT`.
- Registered the stale-workable workflow in Cezar and routed its check step
  through the version-pinned `FACTORY_RUNTIME_ROOT` instead of an unregistered
  workflow-only path.
- Included the stale-workable workflow in the default Factory installation
  profile so full-layer projects receive its script, workflow, and automation.
- Added explicit `-Enable` propagation to Factory release synchronization so a
  newly registered requested schedule is not left paused by default.
- Added a four-hour, two-issue stale-workable refresh that retriggers only
  executable lifecycle labels and excludes manual, blocked, malformed, and
  unroutable issues.
- Documented the complete label-driven lifecycle and added a validated GitHub
  lifecycle updater that writes routing labels before the downstream state event
  and can deliberately retrigger an unchanged state.
- Moved deterministic legacy-label resolution into the backlog audit: blocked
  work, decomposition markers, and unambiguous type markers now receive a
  durable Factory state before the agent sees the artifact. The artifact now
  records its actual worktree and absolute output path, preventing stale
  project-root JSON from being treated as the current run.
- Made the untagged-candidate filter explicit after GitHub search and record
  the audit reservation separately from each candidate's pre-audit labels.
- Made the audit normalize all statically classifiable issues in the fetched
  backlog; the three-issue cap now applies only to ambiguous LLM work.
- Expanded the source fetch to the GitHub CLI maximum so static normalization
  covers the full open backlog rather than only the first page.
- Made the backlog-label audit treat a missing Cezar runtime mount as a
  deployment failure and explicitly forbid nested-shell recovery or script
  discovery.
- Replaced the Cezar audit's shell-fragile inline PowerShell resolver with its
  stable mounted-runtime entry point.
- Reserved `factory:needs-help` for genuine human escalation; decomposition
  findings now enter large-model planning instead.

## [0.3.20] - 2026-10-05

### Fixed
- Made backlog-audit script resolution shell-safe and explicitly prevented
  treating `create-labels.ps1` as the audit entry point.

## [0.3.19] - 2026-10-05

### Fixed
- Resolve the backlog audit from the mounted Cezar runtime first and document
  shell-safe PowerShell invocation.

## [0.3.18] - 2026-10-05

### Documentation
- Clarified that active automations execute directly in Cezar and that
  OpenHands/OpenCode materials are legacy reference paths.

## [0.3.17] - 2026-10-05

### Fixed
- Made backlog-audit execution opaque and fail-fast so agents cannot inspect,
  replace, or reconstruct the registered audit script.

## [0.3.16] - 2026-10-05

### Fixed
- Made the Bazzite deployment mount the version-pinned Factory runtime into
  Cezar and OpenHands and preflight the backlog-audit script.

## [0.3.15] - 2026-10-05

### Fixed
- Made the backlog audit resolve its candidate script from the installed
  project layer or registered Factory runtime, supporting remote-only worktrees
  without reintroducing manual issue-list parsing.

## [0.3.14] - 2026-10-05

### Changed
- Made the installed backlog-audit candidate script the mandatory discovery
  path, eliminating agent-side issue-list parsing and fallback reconstruction.

## [0.3.13] - 2026-10-05

### Changed
- Routed all Factory automations through Codex `factory-gateway/factory-code`
  wherever they previously used OpenCode or `litellm/factory-small`.

## [0.3.12] - 2026-10-05

### Fixed
- Restored the valid LiteLLM vLLM model identifier for the `factory-small`
  and `factory-code` logical model groups.

## [0.3.11] - 2026-10-05

### Changed
- Made backlog audits fail fast when the installed candidate source is
  unavailable and added taxonomy hints to prevent repeated manual rework.

## [0.3.10] - 2026-10-05

### Changed
- Bounded backlog-label audits now fetch only their requested candidate count
  and explicitly run as a single pass without ad hoc scripts or re-listing.

## [0.3.9] - 2026-10-05

### Changed
- Made remote-only Cezar automation synchronization the documented default
  release pipeline; local project installation is now an explicit fallback.

## [0.3.8] - 2026-10-05

### Added
- Remote-only Cezar automation synchronization from the Factory checkout,
  without requiring a local application project checkout.

## [0.3.7] - 2026-10-05

### Added
- Autonomous issue intake classification and routing to planning.
- Low-risk approved review auto-merge routing, structured documentation and
  acceptance verification, watchdog investigation routing, and bounded backlog
  dispatch leases.

### Fixed
- Decomposed child issues now enter planning automatically, backlog review
  mapping targets `factory:review`, and stale working issues transition without
  conflicting lifecycle labels.

## [0.3.6] - 2026-10-05

### Added
- Planning now assigns one `complexity:small|medium|large` label. Ready
  implementation automations route those labels to the local bounded model,
  Terra, and Sol respectively.

## [0.3.5] - 2026-10-05

### Fixed
- The backlog audit now treats a skipped issue without a re-read, durable
  closing label as failure. Tracking parents must end as `factory:tracking`;
  human asset/fixture choices must end as `factory:needs-help`.

## [0.3.4] - 2026-10-05

### Added
- `factory-release` and `push-factory-updates.ps1`, which version-pin,
  update, verify, and optionally synchronize every explicitly configured
  Factory project after a Factory change.

## [0.3.3] - 2026-10-05

### Added
- `audit-backlog-labels.ps1`, an installed, bounded candidate-fetch script for
  the legacy backlog audit. It uses its sibling label-setup script instead of
  `FACTORY_RUNTIME_ROOT`; every fetched candidate is durably staged with
  `factory:needs-help` so it is not evaluated again after an agent failure.
- `factory:tracking`, a non-lifecycle label for epics and tracking parents;
  the backlog audit replaces its temporary reservation with this label.
- The backlog audit no longer lets an unavailable installed script or an unset
  `FACTORY_RUNTIME_ROOT` prevent durable labeling: its skill has a bounded,
  self-contained GitHub CLI fallback.
- Bazzite Podman deployment templates and health-validation scripts for the
  Factory control plane, observability stack, and Mac mini vLLM endpoint.
- Hindsight memory-bank/MCP configuration, LiteLLM-to-Langfuse instrumentation,
  routing policy, Grafana dashboard, and Prometheus alerts.
- Execution-provider records that keep Cezar lifecycle state separate from
  agent session state.

## [0.3.2] - 2026-10-02
### Fixed
- `route-state.ps1` passed `--json labels,comments` unquoted, which PowerShell turns into an array, so the real `gh` rejected it. Quoted. The fake `gh` used in self-tests now rejects non-string arguments, and a harness exception is reported as a failed assertion rather than aborting the run. Found by the first real pilot run, right after 0.3.1.

## [0.3.1] - 2026-10-02
### Fixed
- `route-state.ps1` recursed forever when run with the real `gh`: its helper function was named `Gh`, which PowerShell resolves before the executable. Renamed to `Invoke-Gh`; a self-test now fails any script that defines a function shadowing `gh`, `git`, `uv`, `npm`, `pwsh` or `node`. Found by the first real pilot run.

## [0.3.0] - 2026-10-02
### Added
- Decomposition: a plan may end `readyNotReadyStatus: decomposed` with a `subIssues` list (title, body, type, risk, dependsOn). `route-state.ps1` creates the sub-issues as `factory:new` linked to the parent (idempotent on re-run), comments a summary table, and routes the parent to `factory:human-review`. `validate-result.ps1` checks counts, labels, duplicate titles and dependency indexes; limit `max_sub_issues` (default 40) in `policies/retry.yaml`.
- `factory-plan` skill guidance for when and how to decompose.

## [0.2.1] - 2026-10-01
### Fixed
- `verify.ps1`, `diff.ps1`, `install.ps1` and `update.ps1` now always set an exit code; `verify.ps1` crashed on `$LASTEXITCODE` when run as a standalone process
- Self-tests run the sync scripts as child processes, as users and CI do

## [0.2.0] - 2026-10-01
### Added
- `create-labels.ps1`: idempotently creates every label in `policies/labels.yaml` on the GitHub repo (installed to `.ai/factory/scripts/`)

### Changed
- Self-tests no longer hard-code the factory version

## [0.1.0] - 2026-10-01
### Added
- Initial release of the Cezar factory
- Core skills: factory-plan, factory-implement, factory-review, factory-fix, factory-investigate, factory-learn
- Core workflows: plan, implement, review, fix-review, investigate, maintenance
- Core automations: needs-plan, ready-to-implement, ready-to-review, changes-requested
- Core policies: labels, risk, retry, definition-of-ready, definition-of-done, escalation
- Core schemas: plan, implementation-result, review-result, investigation-result
- Core templates: factory.config.yaml, agentic.config.json, gitignore.fragment
- Core scripts: install.ps1, update.ps1, verify.ps1, diff.ps1
- Documentation: cezar-integration.md, lifecycle.md, synchronization.md, project-integration.md
- VERSION file set to 0.1.0
- README.md

### Changed
- Workflows are now valid Cezar workflows (each step is an agent step or a check step) and install where Cezar loads them: `.ai/cezar/workflows/factory-*.yaml`, `.ai/skills/factory-*`
- Automations are Cezar JSON definitions reconciled through the cockpit API instead of unusable YAML

### Also added
- `validate-result.ps1`, `route-state.ps1` (deterministic label routing, review-round and investigation caps, escalation comments), `sync-automations.ps1`
- Result schemas carry the `issue` number; skills no longer set labels
- Full-replacement overrides for any factory file; `factory:investigate` lifecycle state
- Working sync layer: shared `scripts/lib.ps1`, manifest-based install/update/diff/verify with `-ProjectPath`/`-FactoryPath`, dry-run, ownership checks, obsolete-file removal
- Fixture projects (godot, dotnet, generic), `tests/run-tests.ps1` self-test and GitHub Actions CI
- Standard project validation interface (Phase 12): test-changed.ps1, test-full.ps1, verify.ps1
- LLM-friendly JSON result format for all validation scripts
- Artifact storage for verbose logs, test failures, and verification results
- Structured output with status, stage, passed/failed counts, failure details, and artifact paths
- Reliable exit codes for CI integration
- -Verbose and -Quiet flags for all validation scripts
