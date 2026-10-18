<!-- factory-plan-2026-10-16:semantic -->

Parent: #20; audit: #17; source report: [merged PR #24](https://github.com/bin0110001/cezar-factory/pull/24).
This is an implementation plan, not authorization to bypass review or high-risk approval.

## objective

Make machine success mean passed validation and satisfied acceptance criteria without performing GitHub writes.

## Required reading and files

AGENTS.md; policies/definition-of-ready.md; policies/risk.yaml; docs/shared-factory.md; parent issue; scripts/validate-result.ps1; schemas/implementation-result.schema.json; schemas/review-result.schema.json; scripts/ensure-implementation-result.ps1; tests/run-tests.ps1; tests/fake-gh.ps1.

## Design decisions

1. Keep schema required fields and legacy descriptive strings readable, but normalize explicitly supported success values into a versioned status vocabulary. Unknown, failed, skipped, not-run or unmet values cannot satisfy a success result.
2. Successful implementation requires nonempty testsRun/filesChanged, a qualified PR URL and substantive acceptance verification. Keep documentationUpdated=false legitimate; knownConcerns can contain explicitly nonblocking notes, so do not reject every nonempty concern mechanically.
3. Introduce versioned validation receipt fields (schemaVersion, issue, repository, pr, headSha, stage, status, exitCode, artifactPaths). Receipt provenance is the workflow command, never agent assertions. Optional legacy results remain parseable but cannot qualify as merge evidence.
4. Keep failure results representable and preserve the local RouteOnFailure work; do not fold failure routing changes into a semantic rewrite.

## suggestedWorkBreakdown

1. Add table-driven negative fixtures for the reproduced success/failed/Not met result, empty testsRun, placeholder acceptance and malformed PR URLs.
2. Implement pure normalization and semantic checks with concise field errors; update producers only where their outputs would become invalid.
3. Define receipt schema and distinguish legacy/agent-reported evidence from workflow-generated trusted evidence.
4. Exercise current valid/failure examples and install/update fixture compatibility.

## acceptanceCriteria

- [ ] Given a success result with failed or not-run tests or unmet criteria, validation fails with the contradictory field named.
- [ ] Given a legitimate failure result or a success with documentationUpdated=false and documented nonblocking concerns, validation handles it without inventing a blocker.
- [ ] Given a legacy result without trusted head-bound evidence, it may be displayed but cannot authorize merging.
- [ ] Validation tests perform no real GitHub writes.

## Validation

Factory suite on Windows/Linux; mutation fixtures for every contradictory and compatible case; schema checks of all updated producer examples.

## nonGoals

No PR merge command, repository-setting changes, new lifecycle labels or validation runner implementation.

## risks

risk:medium: Result/schema/workflow compatibility can affect every configured project; preserve legacy-readable data, add negative regression cases, avoid real external writes in tests, and independently review the change.

## dependencies

None; independently implementable.

Required by: #27

## requiredProjectSkills

`factory-implement`, `factory-review`. Any Factory-managed implementation must follow factory-release/factory-finish-release and the contributor release gates.

## unresolvedQuestions and approval

No unresolved implementation-design question. No additional human plan approval is required at this risk level; independent review is still required.
Current repository auto-merge/protection configuration remains a release-completion gate until its separate operations plan is approved and verified.

## complexity and readiness

complexity:medium; readyNotReadyStatus: ready. Planning is complete. Lifecycle: factory:human-review as a planning-only scheduling handoff; no further planning or extra medium-risk plan approval is required. Setting factory:ready would dispatch implementation, which is outside this planning-only handoff.

## memoryRecall

No connected Hindsight recall tool was available for this planning session; no memories or bank queries are claimed. Decisions above come from repository source and GitHub evidence.



