# Factory Lifecycle

This document defines the state transitions for issues in the Cezar factory.

## States

- `factory:new` - Initial state when an issue is created.
- `factory:needs-plan` - Ready for planning.
- `factory:needs-help` - Requires human input to proceed.
- `factory:ready` - Planning complete, ready for implementation.
- `factory:working` - Implementation in progress.
- `factory:review` - Implementation submitted for review.
- `factory:changes-requested` - Reviewer requested changes.
- `factory:human-review` - Requires human review (e.g., for high-risk changes).
- `factory:blocked` - Blocked by external dependencies.
- `factory:done` - Work is complete.
- `factory:investigate` - Repeated failure awaiting classification.

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
    factory:review --> factory:human-review
    factory:human-review --> factory:done
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
   - `factory:needs-plan` → `factory:ready`: Planning automation
   - `factory:ready` → `factory:working`: Implementation automation
   - `factory:working` → `factory:review`: Implementation automation (after completion)
   - `factory:review` → `factory:changes-requested`: Review automation
   - `factory:review` → `factory:human-review`: Review automation (for high-risk)
   - `factory:changes-requested` → `factory:working`: Fix automation
   - `factory:human-review` → `factory:done`: Merge automation (after human approval)
3. **Human-required transitions**:
   - Entry to `factory:needs-help`
   - Entry to `factory:human-review` (optional, based on risk)
   - Exit from `factory:human-review` to `factory:done` (requires human merge)
4. **Blocked work resumption**: When a blocker is removed, the issue returns to `factory:working`.
5. **Conflicting state prevention**: An issue can only have one factory-state label at a time.

## Enforcement

`.ai/factory/scripts/route-state.ps1` applies every transition driven by an agent result: it refuses a transition from the wrong source state, removes all other `factory:*` labels when setting one (so conflicting states cannot persist), and posts the plan, findings or escalation summary as an issue comment.

| Event | Required source | Result |
| --- | --- | --- |
| start | ready, changes-requested, blocked (no-op if working) | working |
| plan-result | needs-plan, new | ready; needs-help if not ready or `risk:high` (human plan approval); human-review if decomposed (sub-issues created as `factory:new`, humans pick which to plan) |
| implement-result | working | review; investigate if the agent reports failure |
| review-result | review | human-review on approval; changes-requested otherwise; needs-help once `max_review_fix_rounds` is reached |
| investigate-result | investigate, working | ready once if the retry is appropriate and confidence is not low; otherwise needs-help |

Humans own: leaving `needs-help`, `human-review` -> `done` (merge), approving `risk:high` plans (relabel `factory:ready`), and resuming `blocked` work (relabel `factory:ready`; blocked is never set by automation).
