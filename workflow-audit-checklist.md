# Workflow Autonomy Audit Checklist

Audit date: 2026-10-05

Goal: a newly submitted issue is automatically evaluated, decomposed when
needed, implemented, reviewed, and completed without external support unless a
genuine unanswered question requires it.

## Critical gaps

- [x] Add an intake automation for newly opened issues.
  - Current GitHub automations react to lifecycle labels, chiefly
    `factory:needs-plan`; none reacts to issue creation or `factory:new`.
- [x] Advance `factory:new` issues to planning automatically after intake
  classification.
- [x] Make decomposed work autonomous.
  - The parent currently moves to `factory:human-review`; children are created
    as `factory:new` and require a human to select and relabel them for
    planning.
- [x] Decide and implement the merge policy for low-risk work.
  - An approved review always routes to `factory:human-review`; there is no
    merge/done automation, although the risk policy permits low-risk
    auto-merge.
- [x] Restrict human gates to genuine questions or explicitly accepted safety
  gates.
  - `risk:high` always needs human plan approval, while medium/high work needs
    human merge approval even when requirements are fully resolved.

## Workflow reliability gaps

- [x] Route exhausted workflow-step failures out of `factory:working`.
  - Failed validation/check steps can exhaust retries without producing a
    result or a lifecycle transition.
- [x] Ensure maintenance does not create conflicting Factory state labels.
  - Its stale-working rule adds `factory:investigate` while leaving
    `factory:working`, contrary to the one-state lifecycle rule.
- [x] Wire the watchdog cancellation outcome into investigation or a bounded
  retry path.
  - The watchdog cancels stale runs but does not route the issue.
- [x] Make backlog reconciliation executable only after its ownership, lease,
  and dispatch rules are defined.
  - It is currently read-only and not connected to automation dispatch.
- [x] Correct the reconciler's `factory:ready-to-review` mapping to the actual
  `factory:review` state.

## Completion and verification gaps

- [x] Enforce Definition of Done in structured implementation/review results.
  - Documentation updates and substantive acceptance-criteria verification are
    not currently required by the result validator.
- [x] Add end-to-end tests for the complete autonomous lifecycle, including:
  - [x] newly opened issue intake;
  - [x] `factory:new` to planning;
  - [x] automatic decomposition and child dispatch;
  - [x] retry exhaustion and stale-run recovery;
  - [x] low-risk completion/merge policy;
  - [x] genuine-question escalation.

## Current validation status

- [x] `scripts/validate-automation-catalog.ps1` passes.
- [x] `tests/run-tests.ps1` passes.
  - Fixture pins are kept in sync with the source Factory version.
- [ ] Verify the deployed Cezar cockpit separately.
  - This audit inspected source definitions only. It did not confirm that
    automations are registered and enabled in any external project.

## Target lifecycle

`issue opened -> intake/classify -> plan -> ready | automatic decomposition |
needs-help only for a genuine unanswered question -> implement -> review/fix
loop -> merge/done`
