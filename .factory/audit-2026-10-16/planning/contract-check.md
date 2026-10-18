<!-- factory-plan-2026-10-16:contract-check -->

Parent: #23; audit: #17; source report: [merged PR #24](https://github.com/bin0110001/cezar-factory/pull/24).
This is an implementation plan, not authorization to bypass review or high-risk approval.

## objective

Catch the audited contract drift with executable negative cases instead of heading/source-string assertions.

## Required reading and files

AGENTS.md; policies/definition-of-ready.md; policies/risk.yaml; docs/shared-factory.md; parent issue; tests/ (new workflow contract tests/harness); tests/run-tests.ps1; .github/workflows/ci.yml; cezar/packages/cezar/src/workflows/{types,load}.ts (read-only reference); schemas/; workflows/.

## Design decisions

1. Use yaml parsing plus the bundled Cezar workflowFileSchema/normalization/stepsIssue through a test-only Node adapter; reuse existing yaml/zod dependencies and pin setup through cezar's lockfile. Do not copy the schema or import the full runtime dependency graph unnecessarily.
2. For Factory pwsh commands, extract -File and script parameters using PowerShell AST/metadata. Validate script existence, declared parameters/common switches and preflight coverage without executing scripts.
3. Explicitly identify command forms the checker supports and fail with actionable diagnostics for unsupported Factory command syntax; shell wrappers are not silently treated as verified.
4. Associate concrete skill JSON examples with result schemas and validate them. Ownership guidance checks get small curated negative examples; do not claim arbitrary prose reasoning is fully machine-verifiable.
5. Wire checks into the normal Windows/Linux CI test gate; add Node setup/test-only dependency install without making deployed PowerShell workflows require Node.

## suggestedWorkBreakdown

1. Create a minimal test adapter around Cezar's schema functions and parse every Factory workflow, including maintenance/environment/upgrade.
2. Add PS AST command/preflight checks and skill-example/schema validation.
3. Add one deliberately broken fixture per contract class, asserting diagnostic file/step/parameter.
4. Remove redundant weak assertions only after replacement coverage; document local/CI prerequisites.

## acceptanceCriteria

- [ ] Missing script/skill, unknown parameter, invalid retry edge, incomplete preflight and invalid concrete example each fail for the intended reason.
- [ ] Every real workflow is checked against the bundled Cezar contract on Windows/Linux.
- [ ] The harness never invokes deployment/lifecycle scripts or makes network changes as part of contract inspection.
- [ ] Unsupported syntax cannot silently pass and production workflows gain no new Node requirement.

## Validation

Run positive inventory and negative mutation suite, clean CI dependency install, then full Factory suite in Windows/Linux matrix.

## nonGoals

No Cezar engine modifications, new production parser, general shell interpreter or broad prose linter.

## risks

risk:medium: Result/schema/workflow compatibility can affect every configured project; preserve legacy-readable data, add negative regression cases, avoid real external writes in tests, and independently review the change.

## dependencies

#32

## requiredProjectSkills

`factory-implement`, `factory-review`. Any Factory-managed implementation must follow factory-release/factory-finish-release and the contributor release gates.

## unresolvedQuestions and approval

No unresolved implementation-design question. No additional human plan approval is required at this risk level; independent review is still required.
Current repository auto-merge/protection configuration remains a release-completion gate until its separate operations plan is approved and verified.

## complexity and readiness

complexity:medium; readyNotReadyStatus: not-ready; lifecycle: factory:blocked. Awaiting prerequisite completion: #32 Plan is complete; prerequisites and approval remain distinct from planning.

## memoryRecall

No connected Hindsight recall tool was available for this planning session; no memories or bank queries are claimed. Decisions above come from repository source and GitHub evidence.


