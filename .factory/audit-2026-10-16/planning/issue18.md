<!-- factory-plan-2026-10-16:issue18 -->

Parent: #17; audit: #17; source report: [merged PR #24](https://github.com/bin0110001/cezar-factory/pull/24).
This is an implementation plan, not authorization to bypass review or high-risk approval.

## objective

Retry failed parity/reconciliation independently of whether the checkout advanced, and record success only after full convergence.

## Required reading and files

AGENTS.md; policies/definition-of-ready.md; policies/risk.yaml; docs/shared-factory.md; parent issue; scripts/deploy/factory-autodeploy.sh; scripts/sync-all-automations.ps1; integrations/bazzite/factory-autodeploy.{service,timer}; tests/ (stubbed autodeploy harness); docs/shared-factory.md.

## Design decisions

1. Remove unchanged-SHA success shortcut. On every timer invocation, retain flock and dirty/divergence checks, fetch the explicit deploy ref, and ensure fast-forward before parity/sync.
2. Compare host SHA and container-visible SHA plus hashes of workflow-referenced scripts/catalog and VERSION, so equal VERSION or equal Git metadata alone cannot hide a wrong mount/stale files. Use only registered paths; do not discover a replacement checkout.
3. Run idempotent sync-all on every healthy tick, including unchanged SHA; this is the explicit drift-reconciliation policy and avoids false success after registry changes or out-of-band automation edits.
4. Write success receipt atomically only after all configured targets succeed, containing sourceSha, version, registryDigest, parity result and target receipts. Store it in an ignored host-local state path, not a tracked checkout file.
5. A failed attempt keeps last successful receipt but emits a distinct failure receipt; next normal tick retries. --force stays backward compatible but is no longer required for recovery. Do not add reset/clean/stash.

## suggestedWorkBreakdown

1. Build shell harness with temporary remote and fake podman/sync/clock commands; reproduce advance-then-fail followed by unchanged tick.
2. Refactor reconciliation policy and same-version content parity, preserve documented blocked exit codes where possible and document any new code.
3. Emit atomic success/failure receipts with registry snapshot digest; preserve global non-overlap lock.
4. Cover already-current/drift, missing registry, mixed target failure, container outage, process interruption, dirty/diverged checkout and lock contention.

## acceptanceCriteria

- [ ] One-time failure after advancement recovers on the next ordinary tick without --force or another commit.
- [ ] An unchanged successful SHA still reconciles current explicit registry/automation drift.
- [ ] Same VERSION but wrong content/mount cannot produce a success receipt.
- [ ] No failed/partial attempt replaces a success receipt; no dirty/divergent checkout is overwritten.
- [ ] Concurrent timer invocations do not overlap writes or sync.

## Validation

Linux shell integration with disposable Git repos and stub podman; bash -n; Factory suite. Approved live validation uses homelab-ssh and the supported timer/deploy flow, never hand edits.

## nonGoals

No promotion changes, new target discovery, service restarts or manual Bazzite checkout edits.

## risks

risk:high: Merge/release/infrastructure authority can affect every configured project; use fake external systems first, require explicit human plan approval, retain refusal behavior, and independently review the exact deployed head.

## dependencies

None; independently implementable.

Required by: #29

## requiredProjectSkills

`factory-implement`, `factory-review`, `factory-finish-release`, `homelab-ssh`. Any Factory-managed implementation must follow factory-release/factory-finish-release and the contributor release gates.

## unresolvedQuestions and approval

No unresolved implementation-design question. Human approval of this high-risk deployment plan. No hard dependency on #21: retry policy can be implemented and tested independently; release orchestration consumes its receipt later.
Current repository auto-merge/protection configuration remains a release-completion gate until its separate operations plan is approved and verified.

## complexity and readiness

complexity:medium; readyNotReadyStatus: not-ready; lifecycle: factory:needs-help. Awaiting explicit human approval of the recorded high-risk plan. Plan is complete; prerequisites and approval remain distinct from planning.

## memoryRecall

No connected Hindsight recall tool was available for this planning session; no memories or bank queries are claimed. Decisions above come from repository source and GitHub evidence.


