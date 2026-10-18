Related validation evidence: #511 and #430. Project-owned harness repair; no live checkout changes.

## Repro

`tools/run-tests-batched.ps1 -ReportsRoot reports/test-runs/issue511` accepts a relative report path, then passes a relative `APPDATA`/`LOCALAPPDATA` directory into Godot. On pinned Godot 4.7, `ProjectSettings.globalize_path("user://...")` remains relative and `DirAccess.open("user://...")` fails. `SessionEditRecoverySnapshotTest` therefore reported seven failures and `SessionMissionEditorHostTest` two; both pass when the same `ReportsRoot` is supplied as an absolute path. This is a harness configuration bug, not a recovery implementation bug.

## Plan and acceptance

1. Normalize `ReportsRoot` to an absolute path after resolving the project root and before creating run/batch directories or process environment variables. Preserve the existing repository-bound report-path check.
2. Rerun `SessionEditRecoverySnapshotTest` and `SessionMissionEditorHostTest` with a relative in-repository `ReportsRoot`; require nonempty result XML and zero failures. Confirm the reported and process APPDATA paths are absolute.
3. Commit and push a focused project-owned PR for independent review. Do not alter recovery data or weaken assertions.

Risk: low; complexity: small. No additional plan approval is required.
