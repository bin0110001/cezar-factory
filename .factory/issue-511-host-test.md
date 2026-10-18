Related acceptance gate: #430 (session editor category and Environment UI) and #500 (honest project validation). Source-only; no live checkout changes.

## Repro at `dev` b7385355

After the pinned Godot 4.7 import, `run-tests-batched.ps1 -IncludePattern SessionMissionEditorHostTest.gd` discovers the suite but produces no `results.xml`. The Godot log reports a parse error at test line 162: `_bind_live_world_logic_controls()` now requires four buttons (monitor, deployment, lens, builder), while the test passes three. A second parse error at line 548 cannot infer the dynamic `UserNotifications` variable type. The runner exits nonzero with zero tests, so earlier historical 17/17 evidence is no longer current.

## Plan

1. Update the test fixture to supply a builder button and callback, and assert its authorized and denied behavior with the other World Logic controls.
2. Give the dynamic `UserNotifications` lookup an explicit type so GDScript can parse the suite without changing application behavior.
3. Rerun this exact suite and check a nonempty `results.xml`; run the related #430 focused suite as a regression check. Keep unrelated quality failures visible.

## Acceptance

- [ ] The suite parses and runs a nonempty test set on the pinned Godot 4.7 binary.
- [ ] World Logic builder and existing monitor/deployment/lens callback gates are tested.
- [ ] The source test change is committed, pushed, and independently reviewed before merge; #430 records the result.

Risk: low; complexity: small. No additional plan approval is needed.
