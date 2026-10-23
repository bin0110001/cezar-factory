# Cezar Factory — Unified Verification & Failure Intelligence (DRAFT)
Date: 2026-10-23
Status: architecture draft; not implementation authorization or a production deployment.

## Purpose
Unify Godot parse/import checks, GdUnit4, custom startup checks, Gua exploratory E2E, performance checks, and other project-owned commands in Cezar Factory without rewriting their test implementations. Test execution must remain independent of Cezar, while Cezar becomes the orchestration, evidence, quality-gate and agent feedback layer.

## Existing ownership and compatibility
- #19 owns replacing heuristic shared validation with explicit project-owned `validation.changed/full/verify` commands. DO NOT create competing config or bypass its migration #39.
- #22/#30/#31 own bounded read-only failure audit and fail-closed GitHub publication. The new Finding ledger is a separate *verification result* store; publication integrates their contract and must not introduce another automatic publisher.
- #17 tracks the current reliability audit. Follow AGENTS.md, policies/risk.yaml and policies/definition-of-ready.md. Work merges via reviewed dev PR, followed by authorized release to explicitly registered targets; no inferred deployment.
- The `cezar/` subproject and Factory integration surfaces must be audited before choosing the actual runtime implementation placement. Do not assume upstream APIs are unchanged.

## Architectural decisions (proposed)
1. **Execution ≠ Verification ≠ Workflow:** keep Cezar's existing scheduler; define Verification as a typed execution plus normalization and policy evaluation.
2. **Single backward-compatible project contract:** extend `validation.changed/full/verify` with optional per-check metadata/manifests. Existing targets remain valid; `changed: skip` is explicit, never a green pass. Schema versions, capability negotiation, migration tests.
3. **Adapter protocol:** discover (optional), preflight, execute, ingest, cleanup; input includes explicit project and worktree IDs, commit/base SHA, environment, timeout, resource locks, cancellation token; output includes exit status, test cases, diagnostics, step metrics, artifact refs and coverage limitations. Any crash/no-tests/unknown status must not become pass.
4. **Results and provenance:** immutable VerificationRun, CheckRun, TestCaseResult, Finding, FindingOccurrence, FindingEpisode, Baseline, ImpactEvidence. Include tool version, commit, platform, test list, selected/deferred coverage and reasons, timing profile, redaction and retention. Store artifacts worktree-/run-isolated; bound logs and public summaries.
5. **Focused selection:** Git diff (merge base), explicit ownership, Godot scene/resource/autoload dependencies, static imports, runtime observations when possible, historical test-to-change associations. Explain why selected; expand on low confidence. Change-aware rechecks + last-failed; periodically run full/nightly coverage. No silent omission of unknown tests.
6. **Nonblocking debt-aware policy:** separate accepted debt baseline, commit comparison baseline and performance baseline; a known unrelated failure does not halt issue work. Record new/worsening/fixed/reopened vs untested/infra error; require comparable verified evidence before adjudication. Distinguish permitted agent continuation from PR merge/release gates. Baseline changes are reviewed, audited and cannot be rewritten by repair agents.
7. **Failure identity:** stable, versioned deterministic fingerprints normalized from tool category, test identity, diagnostic code, symbol and path (avoid volatile line/timestamp); support merge/alias/human overrides. Occurrences immutable, episodes reopenable, resolution only after relevant passing coverage; 'not run' never means resolved.
8. **Hindsight integration:** Cezar DB is source of truth; optional asynchronous, fail-open memory adapter retains condensed incident/fix/recurrence summaries and bank-scoped project lessons. Link run/finding/commit IDs, redact secrets; recall is advisory and provenance-linked, not gate input. No raw log dumps or assumed Hindsight connectivity.
9. **Agent loops:** provide small failure summaries, artifact-on-demand, bounded triage/repair, deterministic rerun of impacted checks. Agents cannot weaken baselines, drop mandatory suites or mutate evidence. Distinguish flaky and infrastructure failures.
10. **UI and CLI:** one run history and verify panel, affected test preview (reason/confidence), findings timeline with episodes and baselines, performance trends, artifacts and agent handoff. CLI syntax is illustrative until agreed in contract.
11. **Worker model:** reuse scheduler and existing worktrees, capability-based routing, lock GUI/display/server/GPU, isolated temporary game data and safe cleanup, quotas/timeouts/cancel. No arbitrary host scanning or production server access.
12. **Gua:** remains separate POC until evaluated. Add as an optional E2E adapter only after proof of scene traversal, input reliability, performance assertions and cleanup; never make Gua prerequisite for M1.

## Contract examples (illustrative, pending schema issue)
```yaml
validation:
  changed: ./scripts/factory/test-changed.ps1
  full: ./scripts/factory/test-full.ps1
  verify: ./scripts/factory/verify.ps1
verification:
  version: 1
  checks:
    godot-parse: { runner: command, tags: [fast], ownership: ["**/*.gd", "**/*.tscn", "**/*.tres"] }
    startup: { runner: command, tags: [smoke] }
    gdunit: { runner: junit-command, tags: [unit] }
    gameplay: { runner: gua, tags: [e2e], optional: true, capabilities: [godot-gui] }
  suites:
    quick: [godot-parse, startup]
    standard: [godot-parse, startup, gdunit]
    full: [godot-parse, startup, gdunit, gameplay]
```
No command may silently declare empty discovery a success. Performance gates consume existing run measurements rather than running the operation twice.

## Proposed milestone sequence
**M0 Audit & contract:** inventory Cezar runtime / Factory boundaries and current TableFlux wrappers. Ratify versioned schema, compatibility and deterministic exit semantics.
**M1 Vertical slice:** generic runner + normalized results + parse/startup/GdUnit adapters + worktree isolation. Use TableFlux as a pilot while preserving project scripts.
**M2 Smart verification:** stable findings/episodes, three baselines, affected selection, evidence-based nonblocking policy, history and selective rerun.
**M3 Memory and workflow:** Hindsight optional adapter, agent repair handoff, UI and CLI, safely reuse #30/#31 publishing.
**M4 Advanced:** performance budgets/history, Gua opt-in E2E, capability-aware worker orchestration, broader project pilots.

## Acceptance scenarios
A. A change in RoomBuilder chooses parse + room GdUnit + map startup + known room-performance coverage; unrelated audio tests are deferred with reasons, not reported passing.
B. A baseline with 42 known failures and a run with 39 known failures and zero verified new regressions may continue under development policy; release policy remains independently enforced.
C. A previously resolved parse error reappears at a shifted line: same Finding ID, new episode, recurrence history and linked prior repair evidence.
D. An error in an unexecuted test remains unknown, not fixed. Uncomparable platforms and failed test infrastructure produce inconclusive/infrastructure statuses.
E. A bad parse command, zero discovered tests, test crash, expired baseline, changed policy, or truncated evidence cannot yield a false green gate.
F. Two concurrent worktrees never share artifact paths or edit production test campaigns.
G. Hindsight offline leaves all verification and history functional, with a retryable memory-outbox receipt.
H. A deliberately delayed room operation fails its controlled-environment performance gate despite functional success.

## Explicit non-goals
No new universal test DSL, no rewrite of GdUnit or TableFlux wrappers before adapter pilot, no mandatory Kubernetes/Dagu/Allure, no autonomous issue publication that duplicates #31, no unrestricted agent changes to baselines, no MCP dependency, no deployment or production file changes as part of planning.

## Risks and validation
Cross-platform PowerShell/Node invocation; Cezar fork/upstream drift; dynamic Godot dependencies; misleading historical comparisons; data retention/privacy; GUI test contention. Require fixture/mutation tests, Windows/Linux matrix, sandboxed service stubs, failure-injection, independent review and explicit target release receipts.

## Work packages
See parent GitHub tracking issue and its sequenced children. Every child follows the Factory definition of ready, risk policy and reviewed release process.
