<!-- factory-plan-2026-10-16:parent-20 -->

## Factory plan: Verified result and merge gates

Parent audit: #17. Planning baseline: local source 767ac01, existing audit and the merged documentation PR #24. This comment supersedes the provisional dependency and unresolved-design choices in the original issue.

### objective

Every inherited acceptance criterion is covered by #25/#26/#27; false success is rejected, effective repository gates exist after explicit approval, and merge eligibility/completion refer to the exact reviewed head.

### readyNotReadyStatus / complexity

decomposed / complexity:large. This issue becomes a tracking parent, not an executable implementation. Child plans are complete; dependent work and high-risk approval retain explicit gates.

### Design decisions

Separate schema/result correctness from merge authority. Adopt workflow-generated head-bound evidence, an independent fresh review, an expected-head merge request and observed-merge completion. Do not infer authorization from agent text or a ready label.

### suggestedWorkBreakdown

Semantic validation #25 and repository policy #26 can advance independently. Current-head auto-merge #27 requires #19, #25 and verified policy #26; policy implementation can be tested with fakes before live gate availability.

### Native subIssues

- [ ] #25: Reject contradictory implementation results and version validation receipts (risk:medium, complexity:medium). The child contains file-level steps, design choices, tests and rollout criteria.
- [ ] #26: Configure and verify the dev review and auto-merge policy (risk:high, complexity:medium). The child contains file-level steps, design choices, tests and rollout criteria.
- [ ] #27: Bind auto-merge eligibility to the current reviewed PR head and observe completion (risk:high, complexity:medium). The child contains file-level steps, design choices, tests and rollout criteria.

### dependencies

#27 depends on #19, #25 and #26. #25 and #26 have no hard prerequisite. Release promotion #28 consumes #27's verification contract.

### acceptanceCriteria

Every inherited acceptance criterion is covered by #25/#26/#27; false success is rejected, effective repository gates exist after explicit approval, and merge eligibility/completion refer to the exact reviewed head. Complete all child acceptance criteria, independent reviews and the required configured-target release/parity checks before closing this parent.

### Validation

Each child specifies negative and positive fixture/subprocess tests. Implementation PRs target dev; required Windows/Linux Factory checks and independent review must pass. Operational tests use fake GitHub/target/host executors until high-risk approval permits a supported live verification. Planning coverage and dependency acyclicity are verified separately; this planning pass does not claim code fixes.

### nonGoals

No unapproved settings changes, direct merge, review bypass, project-runner redesign or automatic approval.

### risks

risk:high: preserve schema and installed/shared compatibility; stage authority-changing operations behind exact-SHA evidence; never overwrite unrelated local or host work. Approval on a tracking parent does not silently approve later revisions of high-risk child plans.

### requiredProjectSkills

factory-implement, factory-review, factory-release, factory-finish-release; homelab-ssh only for approved remote validation.

### unresolvedQuestions

No unresolved design choice remains in this decomposition. High-risk child plans still require explicit human approval under policies/risk.yaml, including the exact GitHub policy arrangement in #26. Do not interpret this user request to plan as implementation or settings approval.

### memoryRecall

No connected Hindsight recall tool was available; no bank queries or recalled memories are claimed.

