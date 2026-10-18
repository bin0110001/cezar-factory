<!-- factory-audit-2026-10-16:merge-gates -->

Parent: #17. Related intake defect: #1. Audit report: [source audit and delivery plan](https://github.com/bin0110001/cezar-factory/blob/7708c1e/docs/factory-audit-2026-10-16.md). Documentation PR: #24.

## Objective and evidence

scripts/validate-result.ps1 accepts status=success with testResult=failed, acceptanceCriteriaStatus=Not met and knownConcerns=Unresolved blocker (reproduced, exit 0). scripts/route-state.ps1 review-result sends the supplied PR URL directly to gh pr merge --auto without reading the PR base, current head, required checks or independent review. Repository auto-merge is currently disabled; dev protection returns HTTP 404.

Source: local 767ac01, cross-checked against dev addbd38. This is a source finding, not proof of a live incident.

## Proposed implementation

Define authoritative validation and review receipts bound to issue, repository, PR and head SHA. Reject contradictory success data, verify the current PR targets dev, verify required validation and independent review at that SHA, enforce high-risk plan approval, and fail closed before any merge request. Report queued auto-merge separately from observed merge completion. Document required GitHub settings without enabling them in this implementation task.

## Dependencies

#19

Required by: #21

## Acceptance criteria

- [ ] A success result with failed/not-run tests or unmet criteria fails validation; meaningful failure results remain representable.
- [ ] Wrong-repository/base PRs, changed heads, failed/pending required checks, unresolved findings and missing independent review cannot request merge.
- [ ] High-risk work without human plan approval cannot request merge.
- [ ] Disabled auto-merge or missing configured review/check gates produces a concrete blocker and never a false success.
- [ ] Completion receipts distinguish an auto-merge request from an observed merge.

## Validation

Use fake GitHub subprocess/API fixtures to assert no merge command occurs for each rejected case; test one valid reviewed dev PR and a head-change race. Run the full Factory suite.

## Scope and gates

No branch protection changes, no bypassing checks or reviews, and no production rollout until a human approves this high-risk plan.

Human plan approval is required before implementation. This proposed plan is not that approval.

Required reading: AGENTS.md, policies/definition-of-ready.md, policies/risk.yaml, the files cited above, docs/shared-factory.md and the audit report. Factory-managed changes must be committed, pushed, independently reviewed through a dev PR, released to every explicitly configured target, and verified before closure.



