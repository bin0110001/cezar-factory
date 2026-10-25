# Skills and automation polish plan

Audit date: 2026-10-25. Status: proposed; implementation has not started.

## Objective

Improve useful work completed by Factory automations, reduce manual recovery,
and move execution guarantees into Cezar where appropriate. Prioritize reliable
execution and clear ownership before further prompt tuning.

This document records a quick, read-only audit of 17 skills, 10 workflows,
automation definitions, Cezar workflow-engine source, and live run metadata from
the three explicitly configured projects. It does not authorize implementation,
schedule changes, deployment, or removal of existing safeguards.

## Progress tracking

Check a task only after its acceptance criteria have been demonstrated. Add the
issue, PR, validation result, or run ID beside the task when completed. Use a
dated note for blockers rather than checking partially completed work.

- [x] Complete the initial source and live-metadata audit.
- [x] Record findings and an ordered implementation plan.
- [ ] Complete Phase 1: stabilize Factory behavior.
- [ ] Complete Phase 2: dependable workflow inputs and results.
- [ ] Complete Phase 3: execution limits and failure handling.
- [ ] Complete Phase 4: explicit project verification.
- [ ] Complete Phase 5: concise skills and operational visibility.
- [ ] Complete pilot evaluation and configured-target rollout.

## Evidence baseline

Latest 20 runs per project, as observed during the audit:

| Project | Done | Failed | Running or queued | Sample creation window (UTC) |
| --- | ---: | ---: | ---: | --- |
| Blackjack/Godot | 11 | 8 | 1 | Oct 25, 04:00–14:00 |
| Factory | 13 | 6 | 1 | Oct 25, 00:00–14:00 |
| TableFlux animation pipeline | 17 | 2 | 1 | Oct 24, 19:00–Oct 25, 14:00 |

Of the 16 failed runs in these samples, eight reported Codex 30-minute
timeouts, two reported targeted-test failures, and six reported other command
failures. These samples cover different time windows and are dominated by
maintenance work. A `done` status does not prove a useful issue or PR outcome.
The sample is not a long-term reliability benchmark.

Evidence came from read-only project-scoped `/api/v1/p/<projectId>/automations`
and `/runs` responses. Run metadata was inspected without raw event-log analysis.
The runs endpoint returned arrays; the requested `limit=20` did not bound the
returned data, so the latest 20 records were selected locally. No raw API export
was saved with this audit; refresh the baseline before judging improvements.

## Findings

| Finding | Evidence | Implication |
| --- | --- | --- |
| Watchdog response mismatch | `scripts/watchdog-automations.ps1` accesses `.runs`, while the live endpoint returns an array. | It can miss runs that should be considered for cancellation. |
| Watchdog selection is too broad | Selection uses running status and age, without a Factory-ownership or progress check. | Once response parsing is fixed, legitimate long-running or unrelated work could be selected. |
| Maintenance couples independent jobs | `workflows/maintenance.yaml` puts agent classification before stale-work refresh and repository housekeeping. | A classification failure prevents later housekeeping steps. |
| Overlapping recovery responsibility | Factory has both enabled hourly maintenance and a separate enabled stale-work refresh schedule. | Reconciliation should establish one intended owner and prevent duplicate effects. |
| Conflicting side-effect ownership | `skills/factory-plan/SKILL.md` tells the agent to post the plan and also says the workflow posts it. The backlog-audit skill directly edits lifecycle labels. | Agents can duplicate actions or bypass the deterministic-consumer model. |
| Verification guesses how to run tests | `scripts/factory/test-full.ps1` discovers files and attempts direct execution; `test-changed.ps1` also uses discovery heuristics. | Validation is fragile across project types. The two observed test failures need diagnosis before attributing them to this mechanism. |
| Execution guarantees live in prose and repair scripts | Already-resolved instructions recur across skills; `ensure-implementation-result.ps1` synthesizes a failure handoff when the agent omits it; reservation recovery and extensive retry prohibitions add complexity. | Cezar should enforce generic execution contracts, leaving task judgment to skills. |
| Policy and delivery documentation drift | The catalog describes OpenHands workers and human merge requirements alongside current Cezar runner profiles and reviewed auto-merge policy; skill operations notes retain pre-shared-mount assumptions. | Contributors and agents receive inconsistent operating instructions. |

The observed timeouts establish a reliability problem, but do not by themselves
identify whether the provider, model, prompt size, tool behavior, or execution
engine caused the stall. Preserve this distinction during implementation.

## Ownership and design boundaries

- **Factory:** risk policy, label mappings, project validation commands,
  task-specific judgment, and review requirements.
- **Cezar:** step execution, artifact contracts, budgets, cancellation,
  conditional execution, recovery primitives, and operational visibility.
- **Existing Cezar mechanisms to extend:** automation leases, durable receipts,
  deduplication, revision checks, and `onFail.retryOn`. Do not introduce a second
  scheduler or claim system to solve the same problem.

## Phase 1 — Stabilize Factory behavior

Owner: Factory. Dependencies: none. This is the recommended first delivery slice.

- [ ] Repair watchdog response parsing against the actual API contract.
  - Acceptance: fixtures cover the live array shape, supported compatibility
    shapes, malformed responses, and explicit failure rather than silent success.
- [ ] Restrict watchdog selection to positively identified Factory runs and
  distinguish elapsed runtime from evidence of stalled progress.
  - Acceptance: unrelated runs and valid long-running work are protected;
    cancellation records its reason and affected run.
- [ ] Diagnose representative timeout failures using bounded run evidence.
  - Acceptance: distinguish provider stalls, tool loops, context pressure, and
    legitimate long execution; record unknowns without guessing.
- [ ] Separate agent classification from deterministic housekeeping.
  - Acceptance: failed or timed-out classification cannot prevent repository
    maintenance or stale-work refresh from executing under their own budgets.
- [ ] Reconcile maintenance and the separate stale-refresh schedule.
  - Acceptance: document one intended owner for each operation; repeated or
    overlapping triggers cannot duplicate side effects. Preserve enabled states
    until an intentional migration changes them.
- [ ] Resolve conflicting side-effect instructions.
  - Acceptance: the planner writes its result and a single deterministic step
    posts it; backlog classification proposes results and a deterministic
    consumer validates and applies label changes with race checks.
- [ ] Reconcile catalog, shared-runtime, release, and merge-policy documentation.
  - Acceptance: documented ownership and delivery paths agree with supported
    behavior, while retaining independent review and high-risk approval gates.

## Phase 2 — Dependable workflow inputs and results

Owner: Cezar, followed by Factory adoption. Dependency: a reviewed platform
contract and compatibility plan before changing workflow syntax.

- [ ] Add declared step inputs and outputs with schema validation.
  - Acceptance: missing or invalid required input/output produces an explicit
    step failure before a dependent step acts.
- [ ] Associate artifacts with their run, step, and attempt.
  - Acceptance: a retry cannot accidentally consume a stale result from an
    earlier attempt or another run.
- [ ] Add conditional execution and explicit no-work outcomes.
  - Acceptance: an already-resolved issue or empty candidate set completes
    without launching an unnecessary agent; the UI explains the skipped work.
- [ ] Add finalizers for failure and cancellation cleanup.
  - Acceptance: cleanup runs under a bounded budget after success, failure,
    or cancellation; cleanup failure remains visible and does not erase the
    original failure. Restart recovery reconciles unfinished cleanup.
- [ ] Migrate Factory workflows to the new contracts.
  - Acceptance: remove redundant missing-result repair and already-resolved
    prose only after equivalent failure and no-work paths pass replay fixtures.

## Phase 3 — Execution limits and failure handling

Owner: Cezar and Factory. Dependency: preserve existing runner and workflow
compatibility; build on current retry and automation receipt mechanisms.

- [ ] Add per-step deadlines and a shared run-level attempt budget.
  - Acceptance: each relevant step has a bounded lifetime; independent retry
    loops cannot repeatedly spend beyond the run's overall budget.
- [ ] Distinguish work-verdict failures from infrastructure failures.
  - Acceptance: missing credentials, unavailable providers, and missing commands
    do not repeatedly invoke a coding agent as if its patch were incorrect.
- [ ] Adopt existing `onFail.retryOn` support in Factory workflows.
  - Acceptance: documented exit codes select only failures the agent can repair;
    other failures terminate or escalate with a concrete reason.
- [ ] Move generic timeout, cancellation, and recovery policy into Cezar.
  - Acceptance: terminal state and recovery actions are durable and auditable;
    repeated cancellation or recovery cannot repeat a completed side effect.
- [ ] Retire redundant external watchdog behavior after parity is proven.
  - Acceptance: platform behavior passes timeout, cancellation, restart, and
    legitimate-long-run cases before the external safeguard is removed.

## Phase 4 — Explicit project verification

Owner: Factory configuration and execution; Cezar result presentation.
Start this alongside Phase 1 where it does not depend on new platform features.

- [ ] Diagnose the two sampled targeted-test failures.
  - Acceptance: record actual failing commands and classify project defects,
    harness defects, and environment failures separately.
- [ ] Configure supported targeted and full validation commands per project.
  - Acceptance: each configured project invokes its real toolchain; generic
    direct execution of discovered test files is no longer the default.
- [ ] Define structured pass, fail, skipped, and unavailable outcomes.
  - Acceptance: missing tooling or absent test coverage cannot appear as a pass;
    review gates consume the actual verification outcome.
- [ ] Cover representative Node, Godot, and Factory verification paths.
  - Acceptance: fixtures include working commands, failed checks, unavailable
    dependencies, no matching tests, and useful failure evidence.

## Phase 5 — Concise skills and operational visibility

Owner: Factory skills and Cezar diagnostics. Dependency: migrate enforcement
before deleting the prose or scripts that currently supply safeguards.

- [ ] Give each skill a compact contract: purpose, bounded inputs, judgment,
  output schema, and escalation criteria.
  - Acceptance: remove duplicate execution instructions and contradictory
    fallbacks; keep task-specific guidance needed to make a good decision.
- [ ] Expose the resolved workflow and skill source for each run.
  - Acceptance: show effective source path, version or content hash, and any
    project override; operators can explain why deployed behavior differs.
- [ ] Expose the effective runner, model, budget, and terminal reason.
  - Acceptance: operators can diagnose a failure without reading raw logs for
    basic execution facts.
- [ ] Track useful outcomes separately from housekeeping success.
  - Acceptance: report issue-to-reviewed-PR completion, manual interventions,
    timeout rate, pickup latency, and cost per accepted outcome; no-work and
    maintenance runs have separate reporting.

## Pilot, rollout, and completion

- [ ] Refresh and preserve a bounded, timestamped baseline before the pilot.
- [ ] Define numeric targets and a representative sample size before measuring
  the change; include useful work and adverse cases rather than only maintenance.
- [ ] Replay representative success, no-work, malformed-output, stale-artifact,
  infrastructure-failure, timeout, cancellation, and restart cases.
- [ ] Choose one explicitly configured pilot project and record why it is
  representative. Record any required high-risk plan approval.
- [ ] Run the pilot within existing lifecycle and review gates; document useful
  outcomes, cost, manual recovery, and failures against the baseline.
- [ ] Obtain independent review and resolve blocking findings.
- [ ] Commit and push implementation changes, use reviewed PRs targeting `dev`,
  and request auto-merge only after required gates pass.
- [ ] For Factory-managed changes, complete `factory-release` and
  `factory-finish-release`, promote only the tested merged commit, and verify
  configured-target synchronization and Bazzite/runtime parity.
- [ ] Record the rollback procedure before broader deployment; expand only to
  explicitly configured targets and verify each result.
- [ ] Remove superseded safeguards only after replacement behavior is proven.
- [ ] Update this plan with evidence and remaining limitations.

## Decision and evidence log

| Date | Decision or result | Evidence / issue / PR | Remaining action |
| --- | --- | --- | --- |
| 2026-10-25 | Prioritize execution reliability and ownership before prompt tuning. | Initial audit summarized above. | Implement through reviewed work items. |
| 2026-10-25 | Extend existing Cezar leases, receipts, deduplication, and retry filtering. | Local Cezar automation and workflow source inspection. | Design generic execution contracts without a parallel scheduler. |

## Source references

- [Workflow step schema and retry filtering](../cezar/packages/cezar/src/workflows/types.ts)
- [Workflow engine](../cezar/packages/cezar/src/workflows/run.ts)
- [Automation store and leases](../cezar/packages/cezar/src/automations/store.ts)
- [Watchdog](../scripts/watchdog-automations.ps1)
- [Maintenance workflow](../workflows/maintenance.yaml)
- [Plan skill](../skills/factory-plan/SKILL.md)
- [Backlog label audit skill](../skills/factory-backlog-label-audit/SKILL.md)
- [Implementation result repair](../scripts/ensure-implementation-result.ps1)
- [Targeted verification](../scripts/factory/test-changed.ps1)
- [Full verification](../scripts/factory/test-full.ps1)
- [Automation catalog](../routing/automation-catalog.json)
- [Shared Factory delivery](shared-factory.md)
- [Cezar skill operations](../skills/factory-cezar-skill-operations/SKILL.md)
