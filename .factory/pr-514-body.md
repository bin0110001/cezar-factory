When `run-tests-batched.ps1` receives a relative `-ReportsRoot`, it builds relative APPDATA paths for Godot. Godot then cannot reopen `user://` directories: the recovery suite had seven false failures even though snapshot files were written. Resolving the created run directory to its absolute path before constructing batch reports and process environment fixes that mismatch.

Validation on pinned Godot 4.7:
- Relative reports argument: `SessionEditRecoverySnapshotTest` 3/3 passed, with an absolute printed run directory and nonempty results XML.
- Relative reports argument: `SessionMissionEditorHostTest` 20/20 passed on this stacked branch.
- `Invoke-Pester tools/tests/run-tests-batched.Tests.ps1`: 26/26 passed.
- `git diff --check` passed.

Closes #514. Depends on #512 for the unrelated host-suite parse repair; this branch includes that commit and its diff will collapse after #512 merges. Independent review required. No registered Cezar checkout was changed.
