<!-- factory-plan-2026-10-16:pr-gate -->

Parent: #20; audit: #17; source report: [merged PR #24](https://github.com/bin0110001/cezar-factory/pull/24).
This is an implementation plan, not authorization to bypass review or high-risk approval.

## objective

Request auto-merge only for the intended dev PR at the exact independently reviewed and validated head.

## Required reading and files

AGENTS.md; policies/definition-of-ready.md; policies/risk.yaml; docs/shared-factory.md; parent issue; scripts/route-state.ps1; scripts/validate-result.ps1; workflows/review.yaml; schemas/review-result.schema.json; tests/fake-gh.ps1; tests/run-tests.ps1; policies/definition-of-done.md.

## Design decisions

1. Resolve repository/issue/PR association from prepared context plus GitHub; require base=dev, open non-draft PR, matching head SHA and head-bound validation receipts.
2. Read repository merge settings, effective branch/ruleset requirements, required check conclusions and PR review/thread state. Missing/unreadable gate policy fails closed; never use --admin or enable settings.
3. Require an independent review receipt bound to head and reviewer identity, distinct from implementation provenance; where repository policy demands GitHub approval, require GitHub approval as well. High-risk plan approval must name the approved plan revision and cannot be inferred from a ready label.
4. Pass the expected head to the merge request to reject head-change races. Keep issue in review while merge is queued; on a later bounded idempotent review/completion check, mark done only after GitHub reports merged. Do not add a blocking polling loop.
5. Keep required-check names policy-driven; tests use fake effective policy. Current missing production gates are a rollout blocker, not permission to synthesize passing evidence.

## suggestedWorkBreakdown

1. Build a read-only eligibility check with a structured allow/deny receipt listing evidence and exact SHA.
2. Wire it as a workflow command before merge routing, with no agent-owned GitHub state edits.
3. Make routing consume the receipt, request merge with head protection, and distinguish queued/merged/refused outcomes.
4. Add bounded completion reconciliation to the existing review path and preserve mutually exclusive lifecycle labels.

## acceptanceCriteria

- [ ] Wrong repository/base/head, failed or pending checks, unresolved review threads, absent independent review or high-risk approval all produce zero merge writes.
- [ ] A head change between check and request is rejected by the merge command.
- [ ] Disabled auto-merge and absent effective gate policy leave an actionable blocker, never done.
- [ ] Queued merge stays distinguishable from observed merged; repeated completion checks are idempotent.

## Validation

Fake-gh cases for all denials, required-check/ruleset fixtures, changed-head race, valid allow case, queued merge then observed merge; full Factory suite.

## nonGoals

Do not enable branch protection/auto-merge, merge unreviewed work or redesign project test execution.

## risks

risk:high: Merge/release/infrastructure authority can affect every configured project; use fake external systems first, require explicit human plan approval, retain refusal behavior, and independently review the exact deployed head.

## dependencies

#19, #25, #26

Required by: #28

## requiredProjectSkills

`factory-implement`, `factory-review`, `factory-finish-release`. Any Factory-managed implementation must follow factory-release/factory-finish-release and the contributor release gates.

## unresolvedQuestions and approval

No unresolved implementation-design question. Human approval of this high-risk plan; production rollout additionally requires configured effective review/check gates.
Current repository auto-merge/protection configuration remains a release-completion gate until its separate operations plan is approved and verified.

## complexity and readiness

complexity:medium; readyNotReadyStatus: not-ready; lifecycle: factory:needs-help. Awaiting explicit human approval of the recorded high-risk plan. Plan is complete; prerequisites and approval remain distinct from planning.

## memoryRecall

No connected Hindsight recall tool was available for this planning session; no memories or bank queries are claimed. Decisions above come from repository source and GitHub evidence.


