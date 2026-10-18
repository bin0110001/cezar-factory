<!-- factory-plan-2026-10-16:publish-evidence -->

Parent: #22; audit: #17; source report: [merged PR #24](https://github.com/bin0110001/cezar-factory/pull/24).
This is an implementation plan, not authorization to bypass review or high-risk approval.

## objective

Publish actionable failure evidence idempotently without losing it on dedupe or partial API failure.

## Required reading and files

AGENTS.md; policies/definition-of-ready.md; policies/risk.yaml; docs/shared-factory.md; parent issue; scripts/audit-factory-failures.ps1 (publisher separation); workflows/failure-audit.yaml; skills/factory-failure-audit/SKILL.md; tests/fake-gh.ps1; tests/run-tests.ps1.

## Design decisions

1. Adopt one canonical issue in the configured Factory repository per project+normalized signature fingerprint. This supersedes the parent's unresolved one-versus-two issue choice: no second project issue is created by the audit.
2. Build evidence before GitHub access and dedupe by an exact HTML marker containing a stable fingerprint that excludes volatile run IDs/timestamps. Project/known issue references use fully qualified URLs.
3. Any lookup/auth/API failure aborts publication; it is never treated as an empty search. Existing exact marker means append/update bounded evidence only when new, with a receipt recording existing/created/failed.
4. Adopt existing legacy issues only with unambiguous repository/project/signature evidence; preserve human body/comments, and flag ambiguous matches for review. Link existing #1 and its historical evidence without claiming intake fixed.
5. Persist publication receipt before retry; after ambiguous create failure, requery marker before another write. No inferred close/resolve or restart.

## suggestedWorkBreakdown

1. Implement artifact-consuming publisher and exact marker matching, including checked gh exit codes.
2. Use one canonical Factory issue, render redacted source evidence and qualified existing-project links consistently.
3. Wire collector/publisher as separate workflow command steps and align the skill's read/write/issue-count contract.
4. Test retries, ambiguous transport outcome, lookup failure, same-repository target, legacy adoption and repeated evidence.

## acceptanceCriteria

- [ ] Repeated identical evidence produces one issue and no duplicate comment; lookup failure produces no issue.
- [ ] Dedupe against an existing issue never discards current evidence, and a transport retry cannot blindly create a duplicate.
- [ ] All published references are repository-qualified; #1 history remains preserved.
- [ ] Collector and publication receipts expose partial/limited results; issue count never exceeds one new canonical issue per run.

## Validation

Fake-gh state/exit/error fixtures and publisher golden bodies; exact-marker mismatch and ambiguous-create tests; full Factory suite.

## nonGoals

No cross-repository issue pair, intake defect resolution, lifecycle implementation routing or recovery-run dispatch.

## risks

risk:medium: Result/schema/workflow compatibility can affect every configured project; preserve legacy-readable data, add negative regression cases, avoid real external writes in tests, and independently review the change.

## dependencies

#30

## requiredProjectSkills

`factory-implement`, `factory-review`. Any Factory-managed implementation must follow factory-release/factory-finish-release and the contributor release gates.

## unresolvedQuestions and approval

No unresolved implementation-design question. No additional human plan approval is required at this risk level; independent review is still required.
Current repository auto-merge/protection configuration remains a release-completion gate until its separate operations plan is approved and verified.

## complexity and readiness

complexity:medium; readyNotReadyStatus: not-ready; lifecycle: factory:blocked. Awaiting prerequisite completion: #30 Plan is complete; prerequisites and approval remain distinct from planning.

## memoryRecall

No connected Hindsight recall tool was available for this planning session; no memories or bank queries are claimed. Decisions above come from repository source and GitHub evidence.


