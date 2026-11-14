# Spec-first change contracts (#178, epic #174)

A second, optional path next to the normal code-first one, for changes whose contract risk warrants it.
It adds no scheduler, planner or state owner: Cezar schedules, `route-state.ps1` moves lifecycle state,
`docs/impact-manifest.md` (#192/#195) predicts impact, and #145/#154 route dependencies.

Rules live in `policies/change-contract.json`; the pure decisions in `scripts/change-contract-lib.ps1`;
the artifact in `templates/change-contract.md`.

## Which path
`Select-ChangePath` returns `spec-first` when the plan declares a contract kind (interface, serialization,
network, migration, godot-resource, build), touches a protected asset, spans three or more modules, or
carries `risk:high` on a type that is not code-first. Bug, docs, test and maintenance changes stay
**code-first** unless they declare a contract kind or touch a protected asset. A hotfix therefore needs no
spec and no approval; its docs are updated after the code in the same PR.

## Contract and approval
The contract (spec, design, tasks, acceptance) is the behavioral source of truth; generated wiki output is
derived and never approved. It is linked from the issue and pinned to the approved base SHA. A spec-first
change waits at the lifecycle's `factory:design-signoff` state (owner role `tech-lead`, `risk-gated` profile);
nothing else is gated, and risk level alone never blocks implementation.

## Staleness and replans
`Test-ChangeContractStale` marks a contract stale when no SHA is pinned, or when the target branch changed a
path the contract covers since approval; an unknown change list is stale, never fresh. A contract may be
replanned `replan.maxReplans` times, then the issue goes to `factory:needs-help` with the question.

## Convergence
`Compare-ChangeContract` compares the contract to the changed paths and to recorded evidence (tests, #132
acceptance). Every contract item needs passing evidence of each required kind. Anything missing, and any
changed path no item covers, becomes a bounded discrepancy with a follow-up task title, filed as an ordinary
GitHub issue. `Verified` is true only with no discrepancy; an agent's statement is not evidence, so nothing is
certified by an LLM alone.

## Concurrency and external changes
Independent agents work on disjoint contracts; overlap is decided by the impact manifest, not here. A
developer's change on the target branch is handled by the staleness check above.
