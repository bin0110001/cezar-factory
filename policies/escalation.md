# Escalation policy

## When to add `factory:needs-help`

Add the `factory:needs-help` label only when an unresolved major architectural
decision materially changes compatibility, ownership, or the system contract
and implementation cannot safely proceed without the user's choice.

Resolve routine ambiguity with the safest reversible assumption and record it.
Route external dependencies to `factory:blocked`; continue other eligible
issues while that dependency is unresolved. Repeated failures and review
disagreement go through automatic investigation and re-planning rather than
asking the user to schedule work.

## Summary before escalation

Before escalating, an agent must post a summary including:
- Observed problem
- Attempts made
- Relevant logs/artifacts
- Current hypothesis
- Recommended next action (or the major architectural choice needed from the user)

## Required information for escalation

When escalating, the following must be included:
1. Observed problem
2. Attempts made
3. Relevant logs/artifacts
4. Current hypothesis
5. Recommended next action (or the major architectural choice needed from the user)

