<!-- factory-plan-2026-10-16:issue19 -->

Parent: #17; audit: #17; source report: [merged PR #24](https://github.com/bin0110001/cezar-factory/pull/24).
This is an implementation plan, not authorization to bypass review or high-risk approval.

## objective

Execute the project's existing configured validation adapters exactly once and produce isolated, trustworthy receipts.

## Required reading and files

AGENTS.md; policies/definition-of-ready.md; policies/risk.yaml; docs/shared-factory.md; parent issue; scripts/factory/{test-changed,test-full,verify}.ps1; scripts/lib.ps1; templates/factory.config.yaml; workflows/{implement,fix-review}.yaml; tests/fixtures/*/scripts/factory/; tests/run-tests.ps1; docs/project-integration.md.

## Design decisions

1. Reuse validation.changed/full/verify scalars and Read-FactoryConfig; do not add a parallel config file or infer test runners by extension.
2. Resolve project root from the current worktree Git root; config is .ai/factory/factory.config.yaml. Execute the explicitly configured command through documented pwsh subprocess semantics from that root. Missing config/command, same-wrapper recursion or unsupported config are errors, not discovery fallbacks.
3. Replace shared wrappers with a common dispatcher plus thin stage entry points. Include verify in required full verification, and fix project-path handling in verify rather than checking the shared runtime for a project pin.
4. Store logs/receipt in worktree-local .factory/artifacts/validation/<stage>/<attempt-guid>/; a concise stable pointer can exist within that worktree only. Bind receipts to repository/head SHA, stage, command, start/end, exitCode, artifact paths and status; dirty-tree evidence cannot authorize head-only merge checks.
5. Missing/empty validation cannot count as passed. Explicitly unsupported optional targeted coverage may report skipped, but full/verify required stages fail closed. Preserve project adapter semantics; wrappers report command success, not invented test counts.

## suggestedWorkBreakdown

1. Add fixture commands and a shared dispatcher that loads existing config, validates stage and starts a child process with separate bounded stdout/stderr.
2. Replace test discovery loops and shared artifact paths; make exceptions/failed launch/nonzero exit agree with receipt and wrapper exit.
3. Wire existing workflow command steps to stage adapters and require full+verify for review, preserving already-resolved no-op behavior.
4. Update project integration/migration guidance and fixture adapters; cover supported PS/.NET/JS/Godot via stub command adapters instead of installing all runtimes in tests.

## acceptanceCriteria

- [ ] Configured changed/full/verify commands run exactly once from the correct worktree; no source/test-file enumeration occurs.
- [ ] Empty project, missing command, recursion, setup exception and nonzero child exit produce explicit non-passing evidence and nonzero required-stage exit.
- [ ] Two parallel worktrees/attempts never share result paths or write to the mounted runtime.
- [ ] Both full and verify requirements are enforced; already-resolved issues still no-op.
- [ ] Paths with spaces and Windows/Linux command semantics are covered by subprocess tests.

## Validation

Fixture subprocess tests with counters/exit injection, cwd assertions, dirty/head identity, concurrent attempts and bounded log output; full Factory suite on Windows/Linux.

## nonGoals

No GitHub merge routing, model changes, automatic project discovery or package-specific test heuristics.

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



