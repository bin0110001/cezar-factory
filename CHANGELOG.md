# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
