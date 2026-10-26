# Factory workflow map

Factory automation is a label-event pipeline. A downstream Cezar automation is
triggered by the `issue.labeled` event for the lifecycle label being added. An
ordinary issue edit is not a workflow trigger; it only gives the GitHub poller
activity from which to advance its cursor.

## Automatic paths

| Current outcome | Update emitted by the workflow | Next automation | Trigger labels |
|---|---|---|---|
| New issue | `factory:new` | Intake | `factory:new` on `issue.opened` or `issue.labeled` |
| Existing backlog issue | Scheduled intake selects oldest `factory:new` | Intake | Schedule, then the same intake route |
| Intake classified | `factory:needs-plan` | Planning | `factory:needs-plan` |
| Plan ready | `factory:ready` plus exactly one complexity label | Implementation | `factory:ready` plus `complexity:*` |
| Implementation succeeds | `factory:review` | Review | `factory:review` |
| Review requests changes | `factory:changes-requested` | Fix review | `factory:changes-requested` |
| Fix succeeds | `factory:review` | Review | `factory:review` |
| Implementation fails | `factory:investigate` | Investigation | `factory:investigate` |
| Investigation retry approved | `factory:ready` plus retained complexity | Implementation | `factory:ready` plus `complexity:*` |
| Review approved with a PR URL | Verify current-head eligibility, request auto-merge with the expected head, and mark done only after GitHub reports merge | GitHub auto-merge | All risk levels after validation and independent review |
| Plan decomposes into children | Parent closes as tracking work; children enter `factory:needs-plan` | Planning then implementation proceeds in dependency order |

The merge eligibility check reads the current PR head, clean full/verify
receipts, required checks, effective `dev` rules, independent approval, and
review-thread state. Missing policy or unreadable evidence denies the merge
request. If GitHub queues auto-merge but has not reported completion, the issue
stays in `factory:review`; an approved review without a PR URL returns to
implementation through `factory:changes-requested`.

Diagnostic baselines classify pre-existing project failures for investigation;
they never waive the required passing full and verify receipts. See
[`validation-baseline-policy.md`](validation-baseline-policy.md).

Every automatic handoff must therefore update the state label after all routing
labels are correct. The state label is the event; the other labels are the
filter envelope.

## Exceptional user-input gate

An unresolved major architectural decision blocks planning. High-risk plans
also wait for explicit human plan approval before implementation. An external
dependency may block one issue, but it does not pause the rest of the backlog.

| Outcome | State | Human action to resume |
|---|---|---|
| High-risk plan awaiting approval | `factory:needs-help` | Review the posted plan and relabel `factory:ready` when approved |
| Unresolved major architectural decision | `factory:needs-help` or `factory:human-review` | Ask one focused question about compatibility, ownership, or the system contract; planning resumes automatically after the answer |
| External blocker | `factory:blocked` | Record the dependency and continue other eligible issues; resume this issue when evidence shows it is clear |
| Independent review finds issues | `factory:changes-requested` | Fix and re-review automatically; user review is not a gate |

`factory:working` is an in-run state, not an inbound automation. The
implementation or fix workflow sets it first, then emits `factory:review` or
`factory:investigate` when its run completes.

When a backlog-level request is active, continue to the next eligible issue
while another issue waits for CI, independent review, or release. Do not wait
for per-issue user scheduling; only a major architectural decision pauses for
user input.

The `[factory] maintenance` automation runs deterministic housekeeping before
backlog classification. The collector emits static rule proposals and at most
three ambiguous candidates; a preparation consumer applies static decisions,
checks live state, and reserves candidates. The agent returns a bounded
proposal and a final consumer rechecks the issue revision and applies it. A
zero-candidate result uses Cezar `no_work` and skips the agent. The workflow
also runs `refresh-stale-workable` and `maintain-repository.ps1` before the
agent step so agent failure cannot suppress those tasks. It does not select or classify issues for intake;
`[factory] intake` is the only intake path. `refresh-stale-workable` is a
repair loop, not a new lifecycle state. It selects at most two open
issues older than 24 hours in `factory:new`, `factory:needs-plan`,
`factory:ready`, `factory:review`, `factory:changes-requested`, or
`factory:investigate`. It skips manual/terminal states, multiple or missing
lifecycle labels, audit/tracking markers, and `factory:ready` issues without
exactly one complexity label. It removes and re-adds only the selected state
label, causing the existing downstream automation to receive a fresh event.

## Update contract

Use `scripts/update-github-lifecycle.ps1` for operator-driven transitions:

```powershell
pwsh -NoProfile -File scripts/update-github-lifecycle.ps1 `
  -Issue 372 -State factory:ready `
  -Complexity complexity:medium -Type type:feature -Risk risk:medium `
  -Retrigger
```

The script validates labels from `policies/labels.yaml`, removes conflicting
labels, writes type/risk/complexity first, and adds the lifecycle label last.
When the requested state is already present, `-Retrigger` removes and re-adds
it in separate edits so Cezar receives a fresh `issue.labeled` event. It never
dispatches a run directly and it refuses an unroutable `factory:ready` unless
`-AllowUnroutable` is explicitly supplied.

## Godot upgrade

`factory-godot-upgrade` (`[factory] godot-upgrade`, daily) adopts new stable Godot releases per
Godot project: check, stage, pin on `factory/godot-<version>`, test, agent fix, re-test, auto-merge
PR. Details in `docs/godot-upgrades.md`.
