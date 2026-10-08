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

Every automatic handoff must therefore update the state label after all routing
labels are correct. The state label is the event; the other labels are the
filter envelope.

## Manual-gate paths

These are intentional stops. Their label updates are durable evidence for a
human, but do not start another automatic workflow until a human chooses a new
executable state.

| Outcome | State | Human action to resume |
|---|---|---|
| Intake has an unanswered product/security/legal/operations question | `factory:needs-help` | Answer the question and set `factory:needs-plan` |
| Plan is not ready | `factory:needs-help` | Resolve blockers and set `factory:needs-plan` |
| High-risk plan | `factory:needs-help` | Approve the plan and set `factory:ready` with complexity |
| Decomposition parent | `factory:human-review` | Review the decomposition; child issues independently enter planning |
| Approved non-low-risk implementation | `factory:human-review` | Complete human review, then set the chosen terminal/executable state |
| Review limit reached | `factory:needs-help` | Decide whether to revise requirements or resume review/fix |
| Investigation cannot safely retry | `factory:needs-help` | Resolve the external blocker and set the chosen executable state |
| Accepted low-risk review | `factory:done` | None; auto-merge is requested |

`factory:working` is an in-run state, not an inbound automation. The
implementation or fix workflow sets it first, then emits `factory:review` or
`factory:investigate` when its run completes.

The `[factory] maintenance` automation runs only fixed script steps plus the
capped legacy-label audit: backlog-label audit, `refresh-stale-workable`, and
`maintain-repository.ps1`. It does not select or classify issues for intake;
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
