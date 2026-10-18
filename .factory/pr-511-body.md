`SessionMissionEditorHostTest` could not parse on `dev`: its World Logic binding fixture passed three controls after the host gained a required builder button, and a dynamic notification lookup lacked an explicit type. The suite therefore produced no results despite historical pass comments on #430.

This updates the fixture to exercise builder callbacks with and without GM edit capability and types the notification lookup. Application code is unchanged.

Validation on pinned Godot 4.7 after import, with an absolute in-repository reports root:
- `SessionMissionEditorHostTest`: 20/20 passed.
- `GameSessionEditorTabExpandedToolsTest`: 26/26 passed.
- `MissionEditorComponentTest`: 13/13 passed.
- `LiveSessionMissionAuthoringAdapterTest`: 3/3 passed.
- `git diff --check` passed.

Closes #511. Related #430 and #500. Independent review required before merge; no registered Cezar checkout was changed.
