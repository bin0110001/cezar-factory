---
name: factory-local-workflow
description: Route local Factory work through the existing Factory skills when a Cezar-triggered upstream workflow has not run.
---

# Run Factory work locally

Use this skill when the user asks to do Factory work in the current checkout and
there is no active Cezar workflow supplying the task context. The repository's
`workflows/*.yaml` files define the Cezar execution order; the `skills/*/SKILL.md`
files define the agent work. Reuse those skills instead of copying their
instructions here.

## Select the existing skill

| Local request | Skill sequence |
|---|---|
| Triage a newly opened issue | `factory-intake` → `factory-plan` |
| Plan an issue | `factory-plan` |
| Implement an issue | `factory-plan` first when no approved plan exists, then `factory-implement` |
| Investigate a failed or unclear attempt | `factory-investigate`; use `factory-plan` if its recommendation requires a revised plan |
| Address review findings | `factory-fix` → `factory-review` |
| Review a completed change | `factory-review` |
| Work through outstanding issues | `factory-work-backlog` |
| Analyze environment or deployment state | `factory-environment-analysis` |
| Upgrade a Godot project | `factory-godot-upgrade` |
| Audit or reconcile backlog labels | `factory-backlog-label-audit` or `factory-work-backlog`, as requested |
| Audit repeated Cezar failures | `factory-failure-audit` |
| Onboard a project | `factory-project-onboarding` |
| Learn or record durable project knowledge | `factory-learn` |
| Operate Factory skills or Cezar automations | `factory-cezar-skill-operations` |
| Release or finish a Factory change | `factory-finish-release` (which uses `factory-release`) |

Read each selected skill from `skills/<skill-name>/SKILL.md` before using it.
When a skill expects a workflow-created artifact that is absent, create the
needed context from the user-provided task and available source evidence, then
continue with the appropriate upstream skill. In particular, do not stop an
implementation solely because `.factory/implementation-context.json` is absent:
read the issue and approved plan, applicable `AGENTS.md` files, and current
repository state. If the plan is absent or unapproved, plan first.

## Local execution boundaries

- Treat the user's current task as the selected work. Do not wait for a label
  event or an upstream automation to start when the required prior stage can be
  completed with the skill sequence above.
- Keep each skill's result artifact and schema as the handoff between stages.
  These artifacts let a later Cezar workflow resume or validate the work.
- Do not edit Factory lifecycle labels, dispatch replacement Cezar tasks, or
  claim that a Cezar workflow step succeeded when it did not run.
- Do not run Factory scripts from this skill. Factory scripts remain owned by
  `command:` steps in `workflows/*.yaml`; use the local skill sequence for the
  agent work and use the configured workflow for script-owned validation and
  routing.
- For code changes outside a verified Factory workflow, follow
  `factory-workspace` before editing and preserve unrelated worktree changes.

## Keep this router current

When adding or renaming a workflow or agent skill, update the routing table above
and verify the referenced file exists. Derive workflow order from the relevant
`workflows/*.yaml` file and keep preparation, validation, and routing steps in
the workflow; do not copy those commands into this skill. If a workflow adds a
new agent stage, add only its skill name and its position in the sequence here.
