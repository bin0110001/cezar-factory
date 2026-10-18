<!-- factory-plan-2026-10-16:portfolio -->

## Planning completed

All six original audit issues now have completed plans. Four were further decomposed into nine native child issues, leaving eleven implementation/operations leaves. Every leaf includes design decisions, affected files, ordered steps, acceptance criteria, negative tests, non-goals, dependencies and approval/rollout gates. Eleven leaf result artifacts and four decomposition result artifacts validate against schemas/plan.schema.json; the dependency graph is acyclic.

The original audit documentation PR #24 has merged and its Windows/Linux CI passed. This supersedes the earlier open-PR status in this tracking issue. No runtime implementation, repository-setting change, automation dispatch or deployment was performed in this planning pass.

| Original issue | Planning outcome |
| --- | --- |
| #19 validation execution | One implementation plan; reuse existing validation.changed/full/verify; worktree-local artifacts and no heuristic source execution |
| #20 merge correctness | Tracking parent: #25 semantic validation, #26 repository policy, #27 current-head merge gates |
| #21 release flow | Tracking parent: #28 immutable reviewed-SHA promotion, #29 command-owned release orchestration |
| #18 deployment retry | One independent high-risk plan; reconcile every timer tick and atomically receipt successful convergence |
| #22 failure evidence | Tracking parent: #30 bounded collection, #31 canonical idempotent publication |
| #23 contracts | Tracking parent: #32 focused skill/preflight repairs, #33 executable CI contract checks |

## Delivery graph

- #19 and #25 define trustworthy project validation and result semantics.
- #26 is the explicit human-approved repository-policy prerequisite; auto-merge is still disabled and dev protection is absent as inspected this session.
- #27 requires #19, #25 and #26; #28 requires #27.
- #18 is independent of the release redesign. #29 requires #18 and #28.
- #30 precedes #31. Choose one canonical Factory issue per project/signature; do not create a second project issue.
- #32 precedes #33. Do not redo the workflow-map correction already merged in #24.

The readiness of a plan is distinct from satisfying prerequisites or approving high-risk operations. High-risk leaves #18, #26, #27, #28 and #29 require explicit human plan approval under policies/risk.yaml. Dependency-gated leaves remain blocked until prerequisites pass. Existing issue #1 remains open with its historical evidence preserved; collector work does not claim it resolved.

Independent medium-risk plans with no hard prerequisite: #19, #25, #30 and #32. Publishing a plan alone does not authorize a separate automation invocation. The factory:ready label triggers implementation; routing of these four is handled separately from plan publication.

