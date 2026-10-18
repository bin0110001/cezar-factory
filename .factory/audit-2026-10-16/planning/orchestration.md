<!-- factory-plan-2026-10-16:orchestration -->

Parent: #21; audit: #17; source report: [merged PR #24](https://github.com/bin0110001/cezar-factory/pull/24).
This is an implementation plan, not authorization to bypass review or high-risk approval.

## objective

Make operator and agent release instructions agree on one resumable release sequence and every configured target's result.

## Required reading and files

AGENTS.md; policies/definition-of-ready.md; policies/risk.yaml; docs/shared-factory.md; parent issue; workflows/ (dedicated Factory release workflow); skills/factory-release/SKILL.md; skills/factory-finish-release/SKILL.md; scripts/push-factory-updates.ps1; scripts/sync-all-automations.ps1; docs/shared-factory.md; docs/synchronization.md.

## Design decisions

1. Release workflow command steps own executable operations; skills describe inputs, artifact review and blockers. PR preparation/independent review happens before promotion and cannot be reordered by finish instructions.
2. Consume promotion SHA receipt, snapshot only the explicit target registry, classify shared versus legacy full-install entries, and validate absolute local projectPath before legacy writes.
3. Shared targets receive promoted mounted content and automation reconciliation; legacy targets get supported dry-run/full-install flows. Never sync unmerged working-tree automation definitions ahead of the promoted SHA.
4. Use per-phase and per-target receipts keyed by source SHA and registry snapshot digest. A retry reruns incomplete targets without hiding a failed target or skipping required reconciliation at unchanged VERSION.
5. Preserve the original contributor command-ownership and remote-checkout refusal rules; do not edit AGENTS.md to exempt release scripts.

## suggestedWorkBreakdown

1. Introduce/extend command-owned release workflow with validation, merged-SHA selection, promotion, sync and runtime parity steps.
2. Make push/sync procedures consume the promoted source checkout and emit target receipts; enforce dry-run for full-layer targets.
3. Rewrite both release skills around those artifacts, repair the malformed promotion path and eliminate duplicate/contradictory procedure text.
4. Test interrupted phases, partial-target failure, absent registry, shared/legacy entries and dirty/mismatched host receipts.

## acceptanceCriteria

- [ ] All phases and target receipts identify the same reviewed source SHA; promotion cannot precede observed reviewed merge.
- [ ] Missing/empty registry, failed target, unsafe local path or dirty/diverged/mismatched runtime stops with exact blocker and no overwrite.
- [ ] Repeated release with matching VERSION still reconciles explicit targets using tested promoted source.
- [ ] Every Factory operation has a workflow command owner; skill prompts contain no script-running instructions.

## Validation

Mock target registry/API/host executors only; dry-run/partial-failure/retry fixtures; contract ownership checks and full Factory suite. Approved live verification uses homelab-ssh and supported host deployment only.

## nonGoals

No host checkout hand edits, target discovery, service-specific infrastructure rollout or GitHub setting changes.

## risks

risk:high: Merge/release/infrastructure authority can affect every configured project; use fake external systems first, require explicit human plan approval, retain refusal behavior, and independently review the exact deployed head.

## dependencies

#28, #18

## requiredProjectSkills

`factory-implement`, `factory-review`, `factory-release`, `factory-finish-release`, `homelab-ssh`. Any Factory-managed implementation must follow factory-release/factory-finish-release and the contributor release gates.

## unresolvedQuestions and approval

No unresolved implementation-design question. Human approval of this high-risk plan. Live rollout requires registry and clean matching Bazzite runtime; stop on absent prerequisites.
Current repository auto-merge/protection configuration remains a release-completion gate until its separate operations plan is approved and verified.

## complexity and readiness

complexity:medium; readyNotReadyStatus: not-ready; lifecycle: factory:needs-help. Awaiting explicit human approval of the recorded high-risk plan. Plan is complete; prerequisites and approval remain distinct from planning.

## memoryRecall

No connected Hindsight recall tool was available for this planning session; no memories or bank queries are claimed. Decisions above come from repository source and GitHub evidence.


