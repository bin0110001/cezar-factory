<!--
managed-by: cezar-factory
source: skills/factory-implement-prepare/SKILL.md
-->
# Factory Implement Prepare Compatibility Skill

This skill exists only to keep Factory installations configured before 0.3.36
updatable. Do not select it for new projects.

The `factory-implement` workflow now owns preparation through its deterministic
`prepare-implementation.ps1` command step. If this compatibility skill is
present in a project configuration, it performs no preparation and must not run
Factory scripts, change lifecycle labels, inspect or select issues, or create
tasks. Use the `factory-implement` skill for implementation work.
