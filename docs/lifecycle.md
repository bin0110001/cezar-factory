# Factory Lifecycle

This document defines the state transitions for issues in the Cezar factory.

## States

- `factory:new` - Initial state when an issue is created.
- `factory:needs-plan` - Ready for planning.
- `factory:needs-help` - Paused only for an unresolved major architectural decision.
- `factory:tracking` - A non-lifecycle marker for an epic or tracking parent;
  it is not executable work and does not require human intervention.
- `factory:ready` - Planning complete, ready for implementation.
- `factory:working` - Implementation in progress.
- `factory:review` - Implementation submitted for review.
- `factory:changes-requested` - Reviewer requested changes.
- `factory:human-review` - Exceptional hold for an unresolved major architectural decision.
- `factory:blocked` - Blocked by external dependencies.
- `factory:done` - Work is complete.
- `factory:investigate` - Repeated failure awaiting classification.
- `factory:implemented` - Work is complete on a pushed branch and has no PR yet. Inert: no automation consumes it.
- `factory:pr-open` - A non-draft PR into `dev` references the issue. Inert; the Factory review loop uses `factory:review` for the same stage.
- `factory:interactive` - A non-lifecycle marker for work done in a local dev window. Stale-work sweeps skip it; it is not a state.

## Transitions

```mermaid
stateDiagram-v2
    [*] --> factory:new
    factory:new --> factory:needs-plan
    factory:needs-plan --> factory:needs-help
    factory:needs-plan --> factory:ready
    factory:ready --> factory:working
    factory:working --> factory:review
    factory:review --> factory:changes-requested
    factory:changes-requested --> factory:working
    factory:review --> factory:done
    factory:working --> factory:implemented
    factory:implemented --> factory:pr-open
    factory:pr-open --> factory:done
    factory:human-review --> factory:needs-plan
    factory:blocked --> factory:working
    factory:working --> factory:investigate
    factory:investigate --> factory:ready
    factory:investigate --> factory:needs-help
    factory:needs-help --> factory:needs-plan
    factory:needs-help --> factory:ready
    factory:done --> [*]
```

## Transition Rules

1. **Legal transitions** are only those shown in the diagram above.
2. **Automation ownership**:
   - `factory:needs-plan` → `factory:ready`: Planning automation; routine ambiguity is resolved with documented assumptions
   - `factory:ready` → `factory:working`: Implementation automation
   - `factory:working` → `factory:review`: Implementation automation (after completion)
   - `factory:review` → `factory:changes-requested`: Review automation
   - `factory:review` → `factory:done`: Independent review, current-head eligibility and local validation receipts pass, auto-merge is requested for that exact head, and GitHub reports the PR merged; otherwise remain in review
   - A decomposed tracking parent closes after creating and queueing its child issues; children plan and implement autonomously in dependency order.
   - `factory:changes-requested` → `factory:working`: Fix automation
   - `factory:human-review` → `factory:needs-plan`: User resolves a major architectural decision; planning resumes automatically
3. **Human-required transitions**:
   - Entry to `factory:needs-help` or `factory:human-review` only when a major architectural decision requires user input
   - User review after delivery is optional feedback, not a workflow gate
   - **PR ownership**: the implementation and fix automations own their PR until it merges. They merge the current `dev` into the branch, resolve conflicts themselves, and leave the PR `MERGEABLE` before handoff; a PR that turns `CONFLICTING` while waiting for review is repaired by the fix automation, never by the user (see `AGENTS.md`, "A job owns its pull request until it merges").
4. **Blocked work resumption**: When a blocker is removed, the issue returns to `factory:working`.
5. **Conflicting state prevention**: An issue can only have one factory-state label at a time.

## Where is my issue? (delivery stages)

Every issue shows its stage by label, and the stage changes as the work moves. GitHub only closes
a `Closes #N` issue when the PR merges into the *default* branch, and Factory PRs merge into
`dev`, so the maintenance workflow does the closing.

| Stage | Label | Who sets it |
|---|---|---|
| In progress | `factory:working` (+ `factory:interactive` in a dev window) | Implementation automation, or the person/agent starting the work |
| Finished, pushed, no PR | `factory:implemented` | The person/agent finishing the work |
| PR open | `factory:pr-open` (`factory:review` in the Factory review loop) | `sync-issue-delivery` step of `factory-maintenance` |
| Merged to `dev` | closed, `factory:done`, comment naming the PR | `sync-issue-delivery` step of `factory-maintenance` |

An issue that sits in a workable state with no activity for 24 hours is re-triggered by the hourly
`refresh-stale-workable` step, two per run, least recently touched first, so every waiting issue gets
its turn. `factory:new` issues are taken in whether or not they already carry a type or risk label.

The sync step only promotes forward from pre-PR states. It never overwrites `factory:review`,
`factory:changes-requested`, `factory:blocked`, `factory:human-review`,
`factory:needs-help`, `factory:investigate`, or `factory:done`, never touches
`factory:tracking` epics, ignores draft PRs, and leaves an issue open if a person reopened it
after it was auto-closed. It runs hourly; a PR must reference its issue with a closing keyword
(`Closes #N`) in its title or body.
## Complexity routing

Planning assigns exactly one `complexity:*` label without changing lifecycle
state. Implementation automation routes small and medium work through the
configured Factory gateway, while large work uses the configured premium
large-work model. The bounded local model is reserved for explicitly cataloged
advisory jobs and never owns implementation. Apply a
complexity label before `factory:needs-plan` when the planning model itself
must be selected in advance; otherwise the normal planner assigns it for the
implementation automation.

## Enforcement

`.ai/factory/scripts/route-state.ps1` applies every transition driven by an agent result: it refuses a transition from the wrong source state, removes all other `factory:*` labels when setting one (so conflicting states cannot persist), and posts the plan, findings or escalation summary as an issue comment.

| Event | Required source | Result |
| --- | --- | --- |
| start | ready, changes-requested, blocked (no-op if working) | working |
| plan-result | needs-plan, new | ready when criteria are met; needs-help only for an unresolved major architectural decision; decomposed parent closes after children are created and queued as `factory:needs-plan` |
| implement-result | working | review; investigate if the agent reports failure |
| review-result | review | done only after GitHub reports the approved PR merged; a denied eligibility gate or queued auto-merge remains in review; changes-requested for fixes; investigate after repeated review disagreement |
| investigate-result | investigate, working | ready for a clear retry; needs-plan for an automatic re-plan; needs-help only for a major architectural decision; blocked for an external dependency |

Users decide only unresolved major architectural choices. A cleared external
blocker is recorded with evidence and work resumes automatically; do not ask
the user to reschedule it. Approved, validated, independently reviewed PRs are
auto-merged into `dev`. Continue other eligible issues while an issue waits on
CI, independent review, or release.
