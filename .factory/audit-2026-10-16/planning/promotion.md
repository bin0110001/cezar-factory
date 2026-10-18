<!-- factory-plan-2026-10-16:promotion -->

Parent: #21; audit: #17; source report: [merged PR #24](https://github.com/bin0110001/cezar-factory/pull/24).
This is an implementation plan, not authorization to bypass review or high-risk approval.

## objective

Make stable promotion prove the exact tested commit is a reviewed merged dev commit, with no public test replacement.

## Required reading and files

AGENTS.md; policies/definition-of-ready.md; policies/risk.yaml; docs/shared-factory.md; parent issue; scripts/release/promote-stable.ps1; tests/run-tests.ps1; .github/workflows/ci.yml; docs/shared-factory.md.

## Design decisions

1. Resolve candidate SHA from a merged dev PR and verify current origin/dev reachability; merge, squash and rebase histories must be explicitly supported by evidence, never assume a single merge commit.
2. Use an isolated clean candidate checkout and the committed catalog/full-suite paths. Remove public -TestScript substitution; test small internal pure functions with fixtures and stub executables on an isolated test PATH rather than adding production bypass flags.
3. Always validate full suite and verify candidate identity/tree before pushing an explicit SHA to stable. Preserve fast-forward requirement and handle concurrent stable advancement as a refusal.
4. Distinguish successful remote lookup with absent stable from failed auth/network lookup; only genuinely absent stable permits bootstrap.
5. Write a versioned promotion receipt with candidate SHA, merged PR, dev SHA, old/new stable SHA, validation artifacts and outcome. Output/report paths stay outside candidate tracked content.

## suggestedWorkBreakdown

1. Refactor candidate selection and ancestry checks around the PR eligibility/evidence contract.
2. Remove public test-script override and replace current happy/failing promotion test seams.
3. Run catalog/full suite against the isolated immutable candidate, recheck identity and push explicit SHA.
4. Document bootstrap, fetch failure, concurrent promotion and rollback-via-revert behavior.

## acceptanceCriteria

- [ ] An unmerged feature SHA, unreachable dev SHA, missing review evidence or dirty/mutated candidate cannot advance stable.
- [ ] No production argument can substitute or skip the mandatory full suite.
- [ ] A failed suite, auth/network failure or divergent/concurrently advanced stable produces no unsafe push.
- [ ] A valid merged SHA promotes fast-forward and produces a receipt tied to that exact tested tree.

## Validation

Temporary bare remotes and fake GitHub evidence; absent stable versus failed fetch, merge/squash/rebase histories, failure/no public override, concurrent stable push and valid promotion; Windows/Linux Factory suite.

## nonGoals

No target synchronization, host deployment, repository-setting changes or hand edits to Bazzite.

## risks

risk:high: Merge/release/infrastructure authority can affect every configured project; use fake external systems first, require explicit human plan approval, retain refusal behavior, and independently review the exact deployed head.

## dependencies

#27

Required by: #29

## requiredProjectSkills

`factory-implement`, `factory-review`, `factory-finish-release`. Any Factory-managed implementation must follow factory-release/factory-finish-release and the contributor release gates.

## unresolvedQuestions and approval

No unresolved implementation-design question. Human approval of this high-risk plan; reuse verified merged-PR evidence from the prerequisite.
Current repository auto-merge/protection configuration remains a release-completion gate until its separate operations plan is approved and verified.

## complexity and readiness

complexity:medium; readyNotReadyStatus: not-ready; lifecycle: factory:needs-help. Awaiting explicit human approval of the recorded high-risk plan. Plan is complete; prerequisites and approval remain distinct from planning.

## memoryRecall

No connected Hindsight recall tool was available for this planning session; no memories or bank queries are claimed. Decisions above come from repository source and GitHub evidence.


