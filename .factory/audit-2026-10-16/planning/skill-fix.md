<!-- factory-plan-2026-10-16:skill-fix -->

Parent: #23; audit: #17; source report: [merged PR #24](https://github.com/bin0110001/cezar-factory/pull/24).
This is an implementation plan, not authorization to bypass review or high-risk approval.

## objective

Remove known prompt contradictions and make copyable result examples schema-valid without broad skill rewrites.

## Required reading and files

AGENTS.md; policies/definition-of-ready.md; policies/risk.yaml; docs/shared-factory.md; parent issue; skills/factory-fix/SKILL.md; skills/factory-review/SKILL.md; skills/factory-plan/SKILL.md; skills/factory-implement/SKILL.md; workflows/{plan,investigate,intake}.yaml; tests/run-tests.ps1.

## Design decisions

1. Use literal valid JSON examples with required issue/documentation fields; move enum alternatives and explanatory placeholders into prose.
2. Planning/review/fix agents write structured artifacts; workflow commands own GitHub comments/routing and prepared issue selection.
3. Replace factory-implement's generic instruction to invoke Factory scripts with current-worktree project-command guidance; retain its bounded command-error handling.
4. Complete startup RequiredScripts from actual downstream command references (including route-plan-or-default), accounting for helper dependencies, without overwriting the current maintenance/backlog work.
5. The workflow-map risk-based text was already repaired in merged PR #24; do not redo it. Release-skill operational text remains owned by #21's orchestration child.

## suggestedWorkBreakdown

1. Enumerate concrete JSON blocks and fix only schema-required/example validity defects.
2. Remove duplicate GitHub comment/script/discovery instructions in affected skills.
3. Complete startup inventories for affected workflows and add focused negative fixtures.
4. Verify rendered Markdown structure, schema validity and existing ownership checks.

## acceptanceCriteria

- [ ] Concrete examples parse as JSON and include all required fields for their declared result kind.
- [ ] Affected skills instruct only artifact production and project-specific development, with no workflow-owned comments/scripts/label writes.
- [ ] Every script called by the affected workflows is covered by preflight or an explicitly validated helper manifest.
- [ ] No unrelated maintenance/backlog edits or completed #24 documentation work are replaced.

## Validation

Schema-validation of actual fenced examples, focused ownership/manifest checks, diff review and full Factory suite.

## nonGoals

No new general workflow parser, release-skill rewrite, model selection or project dispatch changes.

## risks

risk:medium: Result/schema/workflow compatibility can affect every configured project; preserve legacy-readable data, add negative regression cases, avoid real external writes in tests, and independently review the change.

## dependencies

None; independently implementable.

Required by: #33

## requiredProjectSkills

`factory-implement`, `factory-review`. Any Factory-managed implementation must follow factory-release/factory-finish-release and the contributor release gates.

## unresolvedQuestions and approval

No unresolved implementation-design question. No additional human plan approval is required at this risk level; independent review is still required.
Current repository auto-merge/protection configuration remains a release-completion gate until its separate operations plan is approved and verified.

## complexity and readiness

complexity:medium; readyNotReadyStatus: ready. Planning is complete. Lifecycle: factory:human-review as a planning-only scheduling handoff; no further planning or extra medium-risk plan approval is required. Setting factory:ready would dispatch implementation, which is outside this planning-only handoff.

## memoryRecall

No connected Hindsight recall tool was available for this planning session; no memories or bank queries are claimed. Decisions above come from repository source and GitHub evidence.



