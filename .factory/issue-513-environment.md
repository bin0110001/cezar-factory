Child of #430 (approved session-editor category design). Dependency: #504 GameSession headroom and #511/#512 host-suite repair. Related tracking parent: #188. Source-only; do not change the registered Cezar checkout.

## Verified gap at `dev` b7385355

The committed category selector (`027b29b`) and current `GameSessionEditorTabExpandedToolsTest` pass 26/26. However, selecting Environment still presents a one-item placement-tool dropdown (`environment`); the approved design calls for no placement tool there. The MapEditor `StyleSection` exposes skybox and ground, while time-of-day and lighting remain in a separate `GILightingPanel` tab and are not shown by Environment. The current editor test only asserts the Environment placeholder and StyleSection visibility. `SessionMissionEditorHostTest`, `MissionEditorComponentTest`, and the adapter suite cover appearance draft behavior but do not prove the Environment presentation criterion.

## Implementation plan

1. Choose a single owner for the existing skybox/ground/time-of-day/lighting controls within the session editor's Environment presentation. Reuse the current controls and persistence bindings; do not create parallel values or a new save/network schema. Preserve access from any existing navigation path only if it points to that same owner.
2. Make Environment hide or empty the placement-tool dropdown and show the appearance controls. Other categories hide Environment controls while retaining their category-scoped placement tools and room-style gating. Update `MapEditorRoomPieceScopeGating`, `GameSession`, the scene node paths, and `SessionMissionEditorHost` bindings together. Keep GameSession as a thin composition root; do not increase its 16,047-line ratchet. This source change is blocked until #504 restores headroom or an independently reviewed extraction in this PR provides net reduction.
3. Test category switching, control visibility, tool-name mapping, one-shot movement overlay reset, skybox and time-of-day persistence through save/reload, and peer sync via existing map data. Run the four #430 focused suites with pinned Godot 4.7 and inspect nonempty results.

## Acceptance

- [ ] Environment shows skybox, ground, time-of-day, and lighting controls without a placement-tool choice; other categories keep their scoped tools and hide Environment controls.
- [ ] Existing tool IDs, scope gating, active-tool fallback, appearance persistence, and network synchronization retain their behavior.
- [ ] Focused presentation and persistence tests plus relevant full quality/GdUnit gates pass at the reviewed head; the GameSession ratchet is not raised.
- [ ] An independently reviewed source PR is merged before #430 is closed; no live checkout is hand-edited.

Risk: medium (scene node paths and editor UI binding); complexity: medium. The category design was approved in #430, but implementation remains `factory:blocked` on #504's size gate and the existing review chain.
