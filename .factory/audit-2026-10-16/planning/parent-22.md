<!-- factory-plan-2026-10-16:parent-22 -->

## Factory plan: Bounded failure evidence and canonical publication

Parent audit: #17. Planning baseline: local source 767ac01, existing audit and the merged documentation PR #24. This comment supersedes the provisional dependency and unresolved-design choices in the original issue.

### objective

Source reads/output are bounded and redacted; missing identity/coverage is explicit; dedupe/transport/auth failures cannot create speculative duplicates; canonical publication retains known evidence and existing #1 history.

### readyNotReadyStatus / complexity

decomposed / complexity:large. This issue becomes a tracking parent, not an executable implementation. Child plans are complete; dependent work and high-risk approval retain explicit gates.

### Design decisions

Choose one canonical issue in the configured Factory repository per project/signature; do not create a second project issue. Qualified links preserve existing project references. Avoid the unpaginated bulk /runs endpoint; use capped local evidence and optional selected-run API reads. Recovery is explicit and separate.

### suggestedWorkBreakdown

Implement side-effect-free bounded collection #30 first, then exact-dedupe canonical publication #31 against its versioned artifact.

### Native subIssues

- [ ] #30: Produce bounded redacted failure evidence without bulk run enumeration (risk:medium, complexity:medium). The child contains file-level steps, design choices, tests and rollout criteria.
- [ ] #31: Publish one canonical Factory failure issue with fail-closed deduplication (risk:medium, complexity:medium). The child contains file-level steps, design choices, tests and rollout criteria.

### dependencies

#31 depends on #30. Both remain separate from the intake defect #1; historical run evidence in #1 comments must be preserved.

### acceptanceCriteria

Source reads/output are bounded and redacted; missing identity/coverage is explicit; dedupe/transport/auth failures cannot create speculative duplicates; canonical publication retains known evidence and existing #1 history. Complete all child acceptance criteria, independent reviews and the required configured-target release/parity checks before closing this parent.

### Validation

Each child specifies negative and positive fixture/subprocess tests. Implementation PRs target dev; required Windows/Linux Factory checks and independent review must pass. Operational tests use fake GitHub/target/host executors until high-risk approval permits a supported live verification. Planning coverage and dependency acyclicity are verified separately; this planning pass does not claim code fixes.

### nonGoals

No API pagination expansion, speculative intake resolution, blanket run enumeration, dual-issue cross-repository creation or automatic restart from incomplete evidence.

### risks

risk:medium: preserve schema and installed/shared compatibility; stage authority-changing operations behind exact-SHA evidence; never overwrite unrelated local or host work. Approval on a tracking parent does not silently approve later revisions of high-risk child plans.

### requiredProjectSkills

factory-implement, factory-review, factory-release, factory-finish-release; homelab-ssh only for approved remote validation.

### unresolvedQuestions

No unresolved design choice remains in this decomposition. High-risk child plans still require explicit human approval under policies/risk.yaml, including the exact GitHub policy arrangement in #26. Do not interpret this user request to plan as implementation or settings approval.

### memoryRecall

No connected Hindsight recall tool was available; no bank queries or recalled memories are claimed.

