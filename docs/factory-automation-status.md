# Factory automation implementation status

This is the factual companion to `factory-automation-marching-orders.md`.
“Implemented” means the repository contract and its fixture coverage exist; it
does not claim that an external service has run a workflow.

| Backlog item | Status | Evidence / next action |
| --- | --- | --- |
| 1. Repair test baseline | Implemented | `tests/run-tests.ps1` passes; strict-mode checks cover all deployment scripts. |
| 2. Inventory and evidence reconciliation | Implemented | `docs/execution-inventory.md`; Hindsight deployment evidence explicitly says Cezar integration is not yet proven. |
| 3. Automation catalog | Implemented | `routing/automation-catalog.json`, validator, CI step, and routing-consistency checks. |
| 4. Recall client and preflight | Implemented; live proof | NeonPath planning pilot consumed a bounded artifact from the project and Factory banks (2 memories / 1,808 characters); `scripts/hindsight/*`, schemas, and workflow commands exist. |
| 5. Approval-gated retention | Implemented; live gate open | Candidate filter and receipt contract in `scripts/hindsight/client.py`. Operator: approve one candidate and verify a later recall; record it in `docs/hindsight-live-evidence.md`. |
| 6. Live memory pilot | Recall complete; retain gate open | The credential was rotated and the bounded recall succeeded. Operator: approve one eligible retention candidate, verify later recall, and record only compact receipt evidence. |
| 7. Read-only backlog reconciler | Implemented; live queue empty | `scripts/reconcile-backlog.ps1` plus fixtures for ordering, invalid state, blockers, gates, claims, expiry, caps, and no candidates. A read-only `gh issue list` check for `bin0110001/cezar-factory` on 2026-10-04 returned zero open issues. Operator: run against an approved GitHub snapshot when a candidate exists and retain the dry-run artifact. |
| 8. GitHub-visible leases | Implemented; live gate open | `scripts/lease.ps1` uses issue marker comments; collision and idempotent release fixtures pass. Operator: rotate credential, then test one lease on a designated pilot issue. |
| 9. Cezar dispatch | Deliberately disabled | Skill and reconciler are read-only. Operator: approve a low-risk project after dry-run/lease evidence; enable dispatch only through Cezar. |
| 10. End-to-end provider pilot | External gate open | Operator: configure authenticated Codex/Claude OpenHands profiles and nominate one low-risk issue. |
| 11. Shadow evaluation and promotion | Implemented; evidence collection open | `scripts/record-local-evaluation.ps1`, `scripts/evaluate-local-promotion.ps1`, and predeclared catalog thresholds. Operator: collect the required sample size. |
| 12. Incremental automation enablement | Deliberately paused | Operator: enable one project with batch cap one only after items 6–11 have recorded evidence. |

## Selected pilot project: NeonPath

NeonPath is registered with Cezar and has a decomposed implementation backlog:
issue #4 is the parent decomposition record and issues #7–44 are its child
work items. Issue #11 (fictional demo data) is low risk but explicitly depends
on open PR #2, so it is not dependency-ready. Issue #43 (architecture and
developer documentation) is the current low-risk planning candidate.

NeonPath has Factory `0.3.2` managed files and a completed planning-only pilot
for #43. The first isolated-worktree attempt correctly failed because ignored
project-local runtime scripts are not copied into a Git worktree. A later
worktree-off retry completed before it could be cancelled; it was planning-only
and did not lease, dispatch, retain memory, create sub-issues, or modify source.
Future Factory runs must use the registered `FACTORY_RUNTIME_ROOT` model from
`docs/synchronization.md`; worktree isolation is not to be disabled as a
runtime delivery workaround. The post-remediation isolated-worktree preflight
(`f9a73365-92cc-4a88-90f9-0b3f5bf2888d`) completed with zero agent tokens and
verified central recall, validation, and routing scripts from the runtime.

## End-to-end isolation-safe evidence

On 2026-10-05, the normal isolated-worktree `factory-plan` workflow completed
for NeonPath issue #49 using the registered central runtime. Recall, planning,
result validation, and GitHub lifecycle routing all passed; the run produced no
source diff. Because #49 explicitly depends on #14 and #24, it correctly moved
from `factory:new` to `factory:needs-help` rather than becoming executable.
The successful Claude run was `78c92a2c-0637-4641-88fa-55236225a297` (4,406
output tokens; $0.278939). The prior OpenCode attempt completed recall but
stalled in planning at 11,695 tokens and was cancelled without any lifecycle
mutation (`c810936f-2484-48d4-966c-8b36c8d4a0a3`).

## Model-pinned automation registration

On 2026-10-05, NeonPath registered five Factory GitHub automations in Cezar,
all paused with zero runs and zero recorded cost. Their runner/model pins are
validated against `routing/automation-catalog.json`: Claude `sonnet` for
planning/review, Codex `gpt-5.6-terra` for implementation and fix/review, and
OpenCode `litellm/factory-small` for investigation. Maintenance remains absent
until the project explicitly enables its maintenance feature. Enabling any
automation remains a separate operator decision; registration does not process
the existing backlog.

## Live environment evidence

Read-only checks on 2026-10-04 confirmed that Bazzite runs Cezar, Hindsight,
LiteLLM, OpenHands, Langfuse, Prometheus, and Grafana. These health checks are
infrastructure evidence only; they do not satisfy workflow, GitHub mutation,
or provider-pilot exit criteria.

## Safety stop

The previously exposed credential has been rotated. Continue to avoid `gh auth
status` in captured output because it may display token metadata. No token value
is recorded here.
# Blackjack backlog-label audit pilot (2026-10-05)

`blackjackandhookersGadot` is the first backlog-cleanup pilot. Its opt-in
`features.backlog_label_cleanup` installs an hourly Cezar schedule
(`{ "type": "hours", "every": 1 }`) that is capped at three open issues per run,
preserves legacy labels, and may classify executable work with `factory:new`,
one `type:*`, and one `risk:*` label. Epic and tracking parents receive the
non-lifecycle `factory:tracking` marker instead; it never makes legacy work
implementation-ready.

The schedule was registered paused. Manual run `e8dbf10c-40e0-4cba-88fc-dd5fc9d10c37`
with OpenCode `litellm/factory-small` made no token progress and was cancelled;
therefore it was not enabled and made no GitHub label changes. Do not enable it
until the local provider completes a bounded pilot or the model profile is changed
and re-tested.

The pilot error established that OpenCode reserved 4,096 output tokens for a
16,384-token `factory-small` context, leaving 12,288 for injected instructions.
The deploy profile now caps `factory-small` output at 512 tokens; this workload
only emits a compact audit record, so the lower completion budget restores safe
input headroom without changing the model or broadening the audit.

The stalled-run fix is now implemented in `scripts/watchdog-automations.ps1`:
it cancels running jobs older than 15 minutes through Cezar’s run API. The Qwen
deployment example now requests a 32K context; the host service must be restarted
and validated before treating that setting as production-proven.

