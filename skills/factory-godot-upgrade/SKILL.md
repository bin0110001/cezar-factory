<!--
managed-by: cezar-factory
factory-version: 0.3.41
source: skills/factory-godot-upgrade/SKILL.md
-->
# Factory Godot Upgrade Skill

## Purpose and invocation

Fix only a workflow-confirmed `test_regression` after a newer stable Godot is
pinned. The workflow owns release lookup, installation, branch/pin changes,
test execution, retries, and pull-request publication.

## Bounded input and judgment

Use the current worktree, `.godot-version`, `.factory/godot-test.json`,
`.factory/godot-test.log`, relevant project files, and the applicable Godot
migration guide/release notes. Tie the failure to the upgrade; otherwise report
the evidence and stop. Change only upgrade compatibility: removed/deprecated
APIs, renamed types/properties/signals, project/import settings, or compatible
addons. Never weaken tests. Update a test only for an intended behavior change
and explain why.

## Output, escalation, and side effects

Make focused worktree edits; summarize evidence, cause, changed files, and any
human decision needed. Do not run project tests or Factory scripts; workflow
commands run the baseline and retries. Do not change the pin, branches,
remotes, labels, commits, or pull requests. Report and stop on an engine bug
without a workaround or a product decision requiring human input.
