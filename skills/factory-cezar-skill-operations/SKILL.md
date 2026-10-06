---
name: factory-cezar-skill-operations
description: Create, update, deploy, or troubleshoot Factory skills and workflows executed by Cezar, especially when runtime assets and remote automation definitions can drift.
---

# Factory Cezar Skill Operations

Use this skill when changing a Factory skill, Cezar workflow, or automation
whose behavior depends on the Cezar runtime or a project's managed `.ai`
layer. Do not use it for ordinary application skills that do not execute in
Cezar.

## Delivery layers

Treat these as separate deployable layers:

1. The Factory source checkout.
2. The Cezar automation definition, synchronized through the Cezar API.
3. The mounted Factory runtime, used by scripts at
   `/projects/cezar-factory`.
4. The project's managed `.ai` skills and workflows, from which Cezar creates
   isolated worktrees.

Remote-only automation synchronization updates layer 2 only. It does not
update runtime scripts or a project's managed skills/workflows. When a change
touches those layers, use the configured full-install or Bazzite host deployment
path; do not claim that an automation-only release deployed the change.

## Operating rules

- Validate the Factory change, then use the Factory release procedure for all
  explicitly configured targets.
- Inspect the active runtime and project layer after deployment. Verify the
  exact command/path or policy text that must be available to the next Cezar
  worktree.
- For a scheduled automation, use Cezar's manual schedule endpoint only when
  the user authorizes a one-off run. Keep the timer's enabled state unchanged.
- Monitor the created run. Cancel it when it violates bounded-policy rules,
  repeats a completed side-effecting action, or consumes context without making
  bounded progress. A cancellation does not undo labels or artifacts already
  written.
- Preserve the generated artifacts and reconcile any partially applied side
  effects before starting another run.

For deployed-runtime paths, manual run behavior, and the backlog-label-audit
lessons, read [the operations reference](references/runtime-and-audit.md).
