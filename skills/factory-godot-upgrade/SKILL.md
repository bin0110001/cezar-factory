<!--
managed-by: cezar-factory
factory-version: 0.3.41
source: skills/factory-godot-upgrade/SKILL.md
-->
# Factory Godot Upgrade Skill

Make a project's Godot tests pass on a newer Godot release. The workflow has already pinned the
new version on the current branch (`.godot-version`) and recorded the failing run in
`.factory/godot-test.json` and `.factory/godot-test.log`.

## Rules

- Change only what the new Godot version requires: deprecated or removed APIs, renamed
  classes/properties/signals, changed import or project settings, plugin/addon compatibility
  (for example a gdUnit4 or other addon update that supports the new version).
- Check the Godot upgrade guide for the version range and the release notes before guessing.
- Do not weaken, skip, delete, or loosen tests to get them passing. A test that now fails
  because behavior legitimately changed in Godot may be updated, but say why in your summary.
- Do not change `.godot-version`, branches, remotes, labels, or pull requests; the workflow
  owns those. Do not run Factory scripts.
- Re-run the failing tests yourself with the project's own test command (the workflow's pin
  makes `$GODOT_BIN` resolve to the new version from the worktree) until they pass. Fix root
  causes; if a failure is a genuine Godot bug with no workaround, stop and describe it
  instead of hiding it.
- Leave the fixes uncommitted in the worktree; the workflow commits and publishes them after
  its own test run passes.

## Summary

End with a short list of what broke, what you changed, and anything a human should review.
