<!--
managed-by: cezar-factory
source: skills/factory-implement-prepare/SKILL.md
-->
# Factory Implement Prepare Compatibility Skill

## Purpose and invocation

This compatibility entry exists only so Factory installations pinned before
0.3.36 can update. Do not configure it for new projects or invoke it for
implementation work.

## Compatibility response

This entry has no task input, preparation output, or workflow side effect. If
an older installation invokes it, return: “This compatibility entry performs
no preparation; use the active factory-implement workflow.” Then stop. Do not
chain into another skill or create replacement work.

## Ownership and forbidden effects

The `factory-implement` workflow now owns preparation through its deterministic
`prepare-implementation.ps1` command step. If this compatibility skill is
present in a project configuration, it performs no preparation and must not
run Factory scripts, change lifecycle labels, inspect or select issues, or
create tasks. The active workflow selects the issue and invokes
`factory-implement` when implementation is required.
