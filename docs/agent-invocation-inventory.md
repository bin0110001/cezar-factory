# Factory agent invocation inventory

Audit refreshed: 2026-10-25 from the current checkout. This is the Slice 0 / INV-01 inventory for [the skills and automation polish plan](skills-automation-polish-plan-2026-10-25.md). It describes configured behavior; it is not a live run baseline.

## Evidence limits

- Source inventory: 17 skill directories, 10 workflow YAML files, 14 automation JSON files, and `routing/automation-catalog.json`.
- Automation definitions establish triggers and configured runner/model, but the source tree contains no per-invocation token or duration aggregates. Those measurements are **unavailable**, not zero.
- Schedules show configured cadence (hourly maintenance, daily failure audit and Godot upgrade). GitHub event automations are trigger-driven; observed frequency is **unavailable** here.
- The audit does not assert current enabled/paused state at Cezar, actual model resolution, subscription headroom, or accepted-work outcomes. Capture those from bounded run records before a pilot comparison.
- Factory scripts and skill text often contain retry guidance. A workflow retry can repeat an agent call; invocation counts and retry cost are not available in this source-only inventory.

## Workflow agent calls

| Workflow step | Trigger and bounded input | Configured runner/model | Output and external effects | Disposition and rationale | Frequency / cost evidence; owner |
| --- | --- | --- | --- | --- | --- |
| `factory-intake` — none | Issue selection and classification are handled by `select-intake-issue.ps1`, `classify-intake.ps1`, validators and router. | None | Structured intake result; the deterministic router changes lifecycle state. | **Deterministic.** Classification currently uses code rules; no agent call exists to replace. Review rule precision separately before adding any model. | Issue-triggered configuration; run frequency and cost unavailable. Factory owns policy. |
| `factory-plan` — `plan` | One selected issue (`{{task}}`), bounded Hindsight recall artifact, and repository context available to the skill. | `claude / sonnet` across the three complexity variants and the general `needs-plan` automation. | `.factory/plan-result.json`; `route-plan-or-default.ps1` validates and posts/routes it. | **Agent-essential for open issues.** Ambiguity, dependencies, acceptance criteria, and implementation decomposition require judgment. A resolved-issue preflight is contract-validated and its no_work control skips the planner; supported-host replay and live avoided-call measurements remain open. | Issue-labeled; invocation count, tokens, duration unavailable. Factory skill; Cezar executes. |
| `factory-implement` — `implement` | Prepared implementation context and approved issue plan; repository/worktree. | `codex / factory-gateway/factory-code` (small), `codex / gpt-5.6-luna` (medium), `codex / gpt-6.1-sol` (large). | Source changes and implementation result; workflow scripts validate and publish/route downstream effects. | **Agent-essential for eligible work.** Substantive code changes and project-specific reasoning cannot be replaced by deterministic checks. The resolved-issue preflight output is contract-validated and its no_work control skips the implementation agent; supported-runtime replay remains unverified. | Issue-labeled; configured complexity variants; invocation count, tokens, duration unavailable. Factory + project maintainers. |
| `factory-review` — `review` | PR/issue context and changed code, with bounded workflow handoff. | `claude / sonnet` | `.factory/review-result.json`; workflow validates and routes findings. | **Agent-essential.** Independent substantive review requires judgment. Keep result validation and routing deterministic and preserve reviewer independence. | Issue-labeled; invocation count, tokens, duration unavailable. Factory review policy. |
| `factory-fix-review` — `fix` | Actionable review findings and prepared issue/worktree context. | `codex / factory-gateway/factory-code` | Code changes; workflow runs targeted checks and validates/routes the result. | **Agent-essential.** Repairing valid findings requires code reasoning. Re-run only for known repairable work failures after typed failure policy exists. | Issue-labeled; invocation count, retries, tokens, duration unavailable. Factory + project maintainers. |
| `factory-investigate` — `investigate` | Bounded failure context and relevant project/run evidence. | `codex / factory-gateway/factory-code` | Investigation result artifact; workflow validates and routes. | **Agent-essential for novel/ambiguous diagnosis; rules-then-agent for known signatures.** Known exit codes and repeated signatures should be classified deterministically first. | Issue-labeled; invocation count, tokens, duration unavailable. Factory + project maintainers. |
| `factory-godot-upgrade` — `fix` | Structured upgrade check and baseline test result. | `codex / factory-gateway/factory-code` | Godot project changes only when a new stable version is pinned and the project declares a regression exit code; deterministic script re-runs tests and publishes only after a pass. | **Rules-then-agent.** Cezar contracts skip no-upgrade work, skip the agent on passing tests, and gate repair retries to normalized `test_regression` code 1. Missing commands and unknown test codes fail without a repair call. Runtime replay and live eligible-call rate remain unverified. | Daily configured schedule; actual eligible volume, tokens, duration unavailable. Factory + Godot maintainers. |
| `factory-environment-analysis` — `analyze` | Script-generated bounded JSON and Markdown environment snapshots. | No automation definition assigns a runner/model in this checkout; effective profile **unknown**. | `.factory/environment-analysis/analysis.md`; prompt forbids scripts, target discovery, raw logs, and external mutations. | **Conditional reasoning.** Keep narrative analysis only when evidence needs interpretation; deterministic summaries and counts should be produced by the collector/reporting script. | No matching automation JSON; manual/API invocation frequency, runner, tokens, and duration unavailable. Factory operations. |
| `factory-maintenance` — `backlog-label-audit` | Validated `.factory/backlog-label-audit-input.json`, capped at three ambiguous candidates. | `codex / factory-gateway/factory-code` | Read-only `audit-backlog-labels.ps1` emits deterministic classification proposals and candidate snapshots. `apply-backlog-label-audit.ps1 -Prepare` applies static classifications and reservations, then emits a compact typed summary; its post-agent mode applies candidate proposals and persists receipts after checking current lifecycle state, prepared labels, and GitHub `updatedAt` revision. | **Rules-then-agent.** The preparation contract returns Cezar `no_work` after static effects are verified when the ambiguous candidate count is zero, skipping the audit call and post-agent consumer. Runtime replay and eligible-call rate remain unverified. | Hourly configured schedule; eligible volume, invocation count, tokens, duration unavailable. Factory policy + Cezar runtime. |
| `factory-failure-audit` — none | Collector reads bounded recent run evidence and applies deduplication/restart rules. | Automation config sets `codex / factory-gateway/factory-code`, but workflow has no skill step; source inspection found no internal agent invocation in `audit-factory-failures.ps1`. The configured runner may be unused for this command-only workflow; confirm from run receipts. | Script may restart failed intake and create/deduplicated maintenance issues; these are deterministic API/GitHub effects. | **Deterministic.** Failure-signature matching and deduplication are code-owned. Add fixtures for API response shape, retry gating, and deduplicated side effects before changing policy. | Daily configured schedule; actual model invocation, live run frequency, and tokens/duration unavailable. Factory script owner. |
| `factory-maintenance` — other steps | Stale-workable refresh and repository maintenance run before reservation recovery, candidate collection/validation, and the bounded audit agent. | None | Scripts may release reservations, refresh labels, and create summary issues. | **Deterministic.** No agent is needed for these objective transitions. Moving independent housekeeping before the audit agent prevents its failure from suppressing those effects; command-step failures still stop the sequential workflow. | Hourly configured schedule; effects and run receipts should be measured. Factory scripts + Cezar workflow engine. |

`onFail` retry blocks in plan, implement, review, fix-review, investigate, and Godot-upgrade can repeat the associated agent step. Current retry counts and categorized causes were not derivable from workflow definitions alone. Do not infer token savings or repairable-failure rates from the configured maximums.

## Skill coverage (all 17 current skill directories)

| Skill | Workflow invocation / use | Classification |
| --- | --- | --- |
| `factory-backlog-label-audit` | Maintenance `backlog-label-audit` | Rules-then-agent; deterministic classifications and reservations happen first, and Cezar no_work skips the agent and proposal consumer when no ambiguous candidates remain. Runtime replay and eligible-call/override measurements remain open. |
| `factory-cezar-skill-operations` | Human-directed operational guidance | No scheduled agent invocation identified; instructions should report task IDs and stop after queuing an automation. |
| `factory-environment-analysis` | Environment-analysis `analyze` | Conditional reasoning over bounded collector output. |
| `factory-failure-audit` | No workflow `skill:` reference found | No agent invocation identified from workflow YAML; inspect any direct/manual use separately. |
| `factory-finish-release` | Human-directed completion/release guidance | No scheduled invocation identified; deterministic release commands and gates own execution. |
| `factory-fix` | Fix-review `fix` | Agent-essential repair of substantive review findings. |
| `factory-godot-upgrade` | Godot-upgrade `fix` | Rules-then-agent, conditional on a new version and failing tests. |
| `factory-implement` | Implement `implement` | Agent-essential implementation. |
| `factory-implement-prepare` | Compatibility only; no current workflow reference | No active invocation; retain only for documented compatibility until installations migrate. |
| `factory-intake` | No workflow `skill:` reference found; deterministic intake workflow used instead | No current agent invocation. |
| `factory-investigate` | Investigate `investigate` | Agent-essential for novel diagnosis; known signatures can be rules-first. |
| `factory-learn` | No workflow `skill:` reference found | Human-directed memory/lesson reasoning; no automated call found. |
| `factory-plan` | Plan `plan` | Agent-essential planning; workflow owns posting and routing. |
| `factory-release` | Called by finish-release procedure, not an automation workflow | Deterministic synchronization/release operations. |
| `factory-review` | Review `review` | Agent-essential independent review. |
| `factory-work-backlog` | No workflow `skill:` reference found | Human-directed interpretation of deterministic dry-run output; no autonomous dispatch. |
| `interactive-github-backlog` | No Cezar workflow reference found | Human-directed GitHub backlog operations; not part of scheduled agent-call inventory. |

## Automation trigger and profile inventory (all 14 current definitions)

| Definition | Trigger / cadence | Workflow | Runner / model | Call implication |
| --- | --- | --- | --- | --- |
| `changes-requested` | GitHub `issue.labeled` | `factory-fix-review` | Codex / `factory-gateway/factory-code` | Conditional repair agent; frequency unavailable. |
| `failure-audit` | Daily schedule | `factory-failure-audit` | Codex / `factory-gateway/factory-code` | Workflow has no skill step; internal script agent calls unknown. |
| `godot-upgrade` | Daily schedule | `factory-godot-upgrade` | Codex / `factory-gateway/factory-code` | Agent only if upgrade tests fail. |
| `intake` | GitHub `issue.opened`, `issue.labeled` | `factory-intake` | Codex / `factory-gateway/factory-code` | Workflow is deterministic; configured runner may be unused. Confirm runtime dispatch semantics. |
| `investigate` | GitHub `issue.labeled` | `factory-investigate` | Codex / `factory-gateway/factory-code` | Diagnosis agent. |
| `maintenance` | Hourly schedule | `factory-maintenance` | Codex / `factory-gateway/factory-code` | At most one bounded audit call; independent stale-work refresh and repository maintenance run before the agent. |
| `needs-plan-large` | GitHub `issue.labeled`, complexity large | `factory-plan` | Claude / Sonnet | Planning agent. |
| `needs-plan-medium` | GitHub `issue.labeled`, complexity medium | `factory-plan` | Claude / Sonnet | Planning agent. |
| `needs-plan-small` | GitHub `issue.labeled`, complexity small | `factory-plan` | Claude / Sonnet | Planning agent. |
| `needs-plan` | GitHub `issue.labeled` | `factory-plan` | Claude / Sonnet | Overlaps the three complexity variants unless runtime filters make it mutually exclusive; inspect configured Cezar definitions/receipts before consolidation. |
| `ready-to-implement-large` | GitHub `issue.labeled`, complexity large | `factory-implement` | Codex / GPT-6.1 Sol | Implementation agent. |
| `ready-to-implement-medium` | GitHub `issue.labeled`, complexity medium | `factory-implement` | Codex / GPT-5.6 Luna | Implementation agent. |
| `ready-to-implement-small` | GitHub `issue.labeled`, complexity small | `factory-implement` | Codex / Factory gateway | Implementation agent. |
| `ready-to-review` | GitHub `issue.labeled` | `factory-review` | Claude / Sonnet | Independent review agent. |

The plan/frequency rows are source-configured only. They do not prove that all 14 definitions are enabled, synchronized, or non-overlapping on any project.

## Prioritized replacement matrix

| Priority | Candidate | Proposed owner | Disposition | Expected benefit (hypothesis only) / evidence needed |
| --- | --- | --- | --- | --- |
| 1 | Known run/issue state checks, test status, missing prerequisites, lifecycle legality, retryable exit codes | Cezar + Factory scripts | Deterministic preflight plus conditional step (FND-04) | Resolved-issue preflights now skip agent steps in implementation, planning, investigation and fix-review; maintenance/Godot contracts cover no-candidate and no-upgrade paths. Supported-runtime replay and eligible-versus-skipped call measurements remain open. |
| 2 | Backlog label audit objective cases | Factory classifier + deterministic consumer | Rules-then-agent; conditional step skips model when candidate set is empty; agent proposes typed labels only for ambiguity | Avoid routine classification calls and duplicate effects. Replay objective/ambiguous/stale-revision fixtures and record overrides. |
| 3 | Failure-signature categorization | Factory script for known codes; agent for novel evidence | Rules-then-agent | Reduce repeated diagnosis calls; inspect script call graph and replay categorized failures first. |
| 4 | Maintenance workflow independence | Cezar workflow engine | Deterministic parallel/independent steps only after supported semantics | Prevent classification failure from suppressing housekeeping. Establish receipts/dedup and preserve schedules until an approved migration. |
| 5 | Plan, implementation, substantive review, novel investigation | Appropriate reasoning agent | Agent-essential | No replacement proposed. Bound evidence and retries; compare accepted outcomes, not just call counts. |

Repeated same-state checks and workflow retries exist in prose/config, but this inventory does not quantify redundant calls. Estimates require bounded run exports with run/step IDs, retry reason, model, token usage, timestamps, and accepted issue/PR outcomes.

## Next evidence required

1. Save a bounded, timestamped baseline per explicitly configured project, including query parameters, source version, sample windows, run/step outcomes, model/token/duration fields when supplied, and missing-field counts.
2. Compare local automation definitions with configured Cezar definitions to resolve enabled status and the broad `needs-plan` overlap; do not change schedules during this check.
3. Preserve the existing plan's phase gates. Cezar schema, UI, budget, and routing work must be separately reviewed and replay-tested before Factory workflows rely on it.
