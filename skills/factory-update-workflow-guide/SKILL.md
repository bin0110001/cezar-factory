---
name: factory-update-workflow-guide
description: Reconcile the Factory's end-to-end workflow and ownership guide with its current workflow, lifecycle, validation, and release sources after process changes.
---

# Update the Factory workflow guide

Keep `docs/workflow-map.md` accurate as the single end-to-end overview of the default Factory issue workflow, job ownership, PR lifecycle, validation, and release handoff.

## When to use

Use this skill when a change alters any part of the default process: issue selection or routing, lifecycle ownership, workflow/job/step responsibilities, workspace fencing, implementation or review, PR ownership and merge, validation evidence, or release/promotion. Also use it when a review finds that the guide and the process sources no longer agree.

Do not use it for ordinary product/code changes that leave Factory process behavior unchanged. This skill maintains documentation; it does not authorize or implement workflow behavior changes by itself.

## Reconciliation process

1. Read `docs/workflow-map.md` and its **Sources of truth** index.
2. Inspect the current authoritative files relevant to the change. At minimum, consult the applicable `AGENTS.md`, `policies/lifecycle.json`, workflow YAML, automation definitions, lifecycle scripts/docs, local validation guidance, review/implementation skills, and release policy/docs. Read actual definitions rather than relying on changelog summaries or old guide text.
3. Trace the real path across the issue state, automation trigger, workflow steps, agent skill, validation gate, PR owner, merge confirmation, and release owner. Distinguish the job that owns code/PR delivery from a reviewer or workflow step that only validates or routes it.
4. Update only the affected parts of `docs/workflow-map.md`. Explain the default path first, then state exceptions and ownership boundaries. Link to detailed sources rather than duplicating their full state tables or procedures. Keep the source index current when a new primary source becomes authoritative.
5. If authoritative sources disagree, do not silently choose one. Describe the observable behavior accurately and record a concise **Known process gaps** entry in the guide naming the conflicting sources and the behavior that needs a decision or implementation. Ask the user only if resolving it requires a major architectural choice; routine documentation can preserve the uncertainty.
6. Check each statement against its source, ensure links point to existing files, and make the guide clear about policy versus implemented behavior. Remove stale claims when the underlying behavior changes.

### Full baseline reconciliation

For an initial or requested whole-process write-up, audit the complete path rather than only the changed component:

1. Trace issue arrival and selection, including event filters, scheduled catch-up, stale refresh, and the explicit backlog-selection policy. Keep automated bounded intake distinct from a user-directed backlog run.
2. Trace each default issue state through the automation definition, workflow steps, result schema, router, and next state. Note the division between command steps and agent skill steps, what each owns, and which artifact carries the handoff.
3. Trace workspace ownership and recovery, including local interactive work, fenced Cezar runs, run cancellation, investigation, and PR persistence across handoffs.
4. Trace the implementation/fix branch through validation, PR creation, conflict repair, technical review or structured self-review, merge eligibility, actual merge confirmation, issue closure, and post-merge promotion.
5. Check exceptions (blocked work, decomposition, user decisions, no eligible work, validation failure, and release failure) and record any policy/implementation gap under **Known process gaps**.
6. Maintain a source index grouped by concern. Link to detailed procedures rather than copying state tables, eligibility logic, or release gates into the overview.

The result should let a reader answer, for every handoff: who owns the next action, what evidence/artifact is passed, what event or state triggers it, and what proves the job is complete.

## Boundaries

- Do not change workflow, scripts, automations, policies, lifecycle state, validation, release settings, or GitHub state as part of a documentation-only update.
- Workflows own Factory scripts: do not instruct an agent to run a Factory script from this skill or place Factory script invocations in workflow `prompt:` text.
- Do not duplicate detailed policy owned by `policies/lifecycle.json`, `docs/local-validation.md`, or release documentation; summarize and link.
- Keep user authorization unchanged. A process-documentation request does not authorize a Production Run, live deployment, or unrelated repository work.

## Integration with planning and implementation

`factory-plan` already requires the guide and this skill in the work breakdown and acceptance criteria for process changes; `factory-implement` requires reconciliation in the same PR after changing a process source. Keep those hooks current. When adding a new authoritative source or process-change category, add it to this skill's audit steps and to the guide's source index. Set the implementation result's `documentationUpdated` field truthfully.
