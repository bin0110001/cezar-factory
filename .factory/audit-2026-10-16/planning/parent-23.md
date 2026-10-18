<!-- factory-plan-2026-10-16:parent-23 -->

## Factory plan: Skill/workflow contract remediation and enforcement

Parent audit: #17. Planning baseline: local source 767ac01, existing audit and the merged documentation PR #24. This comment supersedes the provisional dependency and unresolved-design choices in the original issue.

### objective

Known instruction/example/preflight defects are fixed; missing script/skill, unknown parameter, invalid retry edge and bad example each fail a targeted negative contract fixture with an actionable diagnostic.

### readyNotReadyStatus / complexity

decomposed / complexity:large. This issue becomes a tracking parent, not an executable implementation. Child plans are complete; dependent work and high-risk approval retain explicit gates.

### Design decisions

Use actual bundled Cezar schema functions instead of copying schemas, and inspect command AST rather than executing scripts. Concrete JSON examples are literals; prose alternatives are separate. The workflow-map correction is complete in merged #24 and is excluded from remaining work.

### suggestedWorkBreakdown

Repair concrete examples, ownership instructions and preflight inventories in #32; then add an executable Cezar-schema/PowerShell-AST contract harness in #33.

### Native subIssues

- [ ] #32: Repair concrete skill result examples and workflow ownership instructions (risk:medium, complexity:medium). The child contains file-level steps, design choices, tests and rollout criteria.
- [ ] #33: Check workflow structure, PowerShell command contracts and skill examples in CI (risk:medium, complexity:medium). The child contains file-level steps, design choices, tests and rollout criteria.

### dependencies

#33 depends on #32. #32 is independent of release-skill text, which is owned by #29.

### acceptanceCriteria

Known instruction/example/preflight defects are fixed; missing script/skill, unknown parameter, invalid retry edge and bad example each fail a targeted negative contract fixture with an actionable diagnostic. Complete all child acceptance criteria, independent reviews and the required configured-target release/parity checks before closing this parent.

### Validation

Each child specifies negative and positive fixture/subprocess tests. Implementation PRs target dev; required Windows/Linux Factory checks and independent review must pass. Operational tests use fake GitHub/target/host executors until high-risk approval permits a supported live verification. Planning coverage and dependency acyclicity are verified separately; this planning pass does not claim code fixes.

### nonGoals

No Cezar engine change, broad skill rewrite, model routing change, production Node prerequisite or redo of merged #24.

### risks

risk:medium: preserve schema and installed/shared compatibility; stage authority-changing operations behind exact-SHA evidence; never overwrite unrelated local or host work. Approval on a tracking parent does not silently approve later revisions of high-risk child plans.

### requiredProjectSkills

factory-implement, factory-review, factory-release, factory-finish-release; homelab-ssh only for approved remote validation.

### unresolvedQuestions

No unresolved design choice remains in this decomposition. High-risk child plans still require explicit human approval under policies/risk.yaml, including the exact GitHub policy arrangement in #26. Do not interpret this user request to plan as implementation or settings approval.

### memoryRecall

No connected Hindsight recall tool was available; no bank queries or recalled memories are claimed.

