# Changelog

## 0.3.35

- Made scheduled maintenance deterministic: scripts now perform repository
  lifecycle hygiene and stale-issue summaries, numeric runner arguments are
  removed, and the model is limited to the existing capped ambiguous-label
  review.

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
