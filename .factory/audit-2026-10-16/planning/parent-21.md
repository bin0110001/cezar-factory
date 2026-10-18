<!-- factory-plan-2026-10-16:parent-21 -->

## Factory plan: Reviewed merged-SHA release

Parent audit: #17. Planning baseline: local source 767ac01, existing audit and the merged documentation PR #24. This comment supersedes the provisional dependency and unresolved-design choices in the original issue.

### objective

Unmerged/unreviewed/mutated source cannot promote; mandatory full tests precede stable movement; every target result names the same promoted SHA and partial failure remains resumable and visible.

### readyNotReadyStatus / complexity

decomposed / complexity:large. This issue becomes a tracking parent, not an executable implementation. Child plans are complete; dependent work and high-risk approval retain explicit gates.

### Design decisions

Promotion owns tested commit/ref authority; orchestration owns phase order, explicit target registry and receipts. Production promotion has no test-script replacement. Agent skills describe artifacts; workflow command steps own operations.

### suggestedWorkBreakdown

Implement immutable reviewed-SHA promotion #28 after merge-evidence #27; implement end-to-end release orchestration #29 after #28 and the independent retry/receipt work #18.

### Native subIssues

- [ ] #28: Promote only a verified merged dev SHA with an immutable full-test gate (risk:high, complexity:medium). The child contains file-level steps, design choices, tests and rollout criteria.
- [ ] #29: Orchestrate Factory release phases from reviewed merge through target receipts (risk:high, complexity:medium). The child contains file-level steps, design choices, tests and rollout criteria.

### dependencies

#28 depends on #27. #29 depends on #28 and #18. This replaces the provisional dependency on all of #20; #18 no longer waits for this whole parent.

### acceptanceCriteria

Unmerged/unreviewed/mutated source cannot promote; mandatory full tests precede stable movement; every target result names the same promoted SHA and partial failure remains resumable and visible. Complete all child acceptance criteria, independent reviews and the required configured-target release/parity checks before closing this parent.

### Validation

Each child specifies negative and positive fixture/subprocess tests. Implementation PRs target dev; required Windows/Linux Factory checks and independent review must pass. Operational tests use fake GitHub/target/host executors until high-risk approval permits a supported live verification. Planning coverage and dependency acyclicity are verified separately; this planning pass does not claim code fixes.

### nonGoals

No manual remote checkout updates, inferred deployment targets, untested source synchronization or service-specific rollout.

### risks

risk:high: preserve schema and installed/shared compatibility; stage authority-changing operations behind exact-SHA evidence; never overwrite unrelated local or host work. Approval on a tracking parent does not silently approve later revisions of high-risk child plans.

### requiredProjectSkills

factory-implement, factory-review, factory-release, factory-finish-release; homelab-ssh only for approved remote validation.

### unresolvedQuestions

No unresolved design choice remains in this decomposition. High-risk child plans still require explicit human approval under policies/risk.yaml, including the exact GitHub policy arrangement in #26. Do not interpret this user request to plan as implementation or settings approval.

### memoryRecall

No connected Hindsight recall tool was available; no bank queries or recalled memories are claimed.

