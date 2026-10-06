<!--
managed-by: cezar-factory
factory-version: 0.3.2
source: policies/escalation.md
-->
# Escalation policy

## When to add `factory:needs-help`

Add the `factory:needs-help` label when:
- An agent encounters an issue it cannot resolve after maximum retries.
- The issue requires human judgment or domain expertise.
- There are conflicting requirements or ambiguities that block progress.

## Summary before escalation

Before escalating, an agent must post a summary including:
- Observed problem
- Attempts made
- Relevant logs/artifacts
- Current hypothesis
- Recommended human decision

## Required information for escalation

When escalating, the following must be included:
1. Observed problem
2. Attempts made
3. Relevant logs/artifacts
4. Current hypothesis
5. Recommended human decision

