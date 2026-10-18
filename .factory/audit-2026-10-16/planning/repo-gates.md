<!-- factory-plan-2026-10-16:repo-gates -->

Parent: #20; audit: #17; source report: [merged PR #24](https://github.com/bin0110001/cezar-factory/pull/24).
This is an implementation plan, not authorization to bypass review or high-risk approval.

## objective

Provide the explicit repository-side review/check policy required by safe auto-merge, with human-approved settings and a verified receipt.

## Required reading and files

AGENTS.md; policies/definition-of-ready.md; policies/risk.yaml; docs/shared-factory.md; parent issue; GitHub repository settings/effective rules for bin0110001/cezar-factory dev; .github/workflows/ci.yml (read required check names); policies/risk.yaml; docs/shared-factory.md.

## Design decisions

1. Proposed policy: enable repository auto-merge; protect dev using the repository's supported rule mechanism; require one independent approving review, dismiss stale approvals after code pushes, resolve conversations, require current ubuntu/windows Factory CI checks and prohibit agent/admin bypass.
2. Resolve actual effective check contexts from a fresh CI run rather than assume names from display text. PR #24 passed test (ubuntu-latest) and test (windows-latest), but the configured names must be verified.
3. A human repository administrator must approve the exact settings diff, reviewer availability and bypass policy before any write. This issue does not authorize applying settings.
4. Record before/after effective policy and confirm checks apply to dev; a same-author agent cannot substitute for the required independent reviewer. If unavailable, leave merge blocked.

## suggestedWorkBreakdown

1. Capture effective current rules/settings and propose the exact minimal configuration using observed required CI contexts.
2. Obtain explicit human plan approval covering repository settings and independent-review arrangement.
3. Apply only approved settings through the supported GitHub interface; verify effective enforcement using a non-production test PR without bypassing checks.
4. Record the gate-policy receipt and link it to the current-head merge-gate implementation.

## acceptanceCriteria

- [ ] Approved dev policy requires effective CI, independent fresh review and resolved conversations, with no automatic bypass.
- [ ] Auto-merge is enabled only after explicit settings approval and verified review availability.
- [ ] A failing/unreviewed test PR cannot merge; a compliant PR is eligible for the normal merge path.
- [ ] Before/after configuration and reviewer constraints are recorded without secrets.

## Validation

Read-only effective policy inspection first; after human-approved application use a controlled test PR, confirm rejection/eligibility without merging unreviewed changes.

## nonGoals

No source implementation, broad organization policies, direct merge, bypass grant or unapproved settings write.

## risks

risk:high: Merge/release/infrastructure authority can affect every configured project; use fake external systems first, require explicit human plan approval, retain refusal behavior, and independently review the exact deployed head.

## dependencies

None; independently implementable.

Required by: #27

## requiredProjectSkills

`github-issues`. Any Factory-managed implementation must follow factory-release/factory-finish-release and the contributor release gates.

## unresolvedQuestions and approval

No unresolved implementation-design question. Human approval of the exact high-risk repository settings and independent-review arrangement.
Current repository auto-merge/protection configuration remains a release-completion gate until its separate operations plan is approved and verified.

## complexity and readiness

complexity:medium; readyNotReadyStatus: not-ready; lifecycle: factory:needs-help. Awaiting explicit human approval of the recorded high-risk plan. Plan is complete; prerequisites and approval remain distinct from planning.

## memoryRecall

No connected Hindsight recall tool was available for this planning session; no memories or bank queries are claimed. Decisions above come from repository source and GitHub evidence.


