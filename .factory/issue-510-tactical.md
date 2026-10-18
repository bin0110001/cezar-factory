Parent: #504 (restore GameSession headroom) and tracking parent #188. Sequence after or independently of #509; do not combine the two in one PR. This is a proposed high-risk structural slice and requires human plan approval before source changes. Do not edit the registered Cezar checkout.

## Current evidence

At `dev` SHA `b7385355`, GameSession lines 7427–7937 contain 25 tactical/click-to-move functions spanning about 511 gross lines. Lines 8150–8347 contain 11 marker functions spanning about 198 gross lines. `SessionCharacterMarkerController` already owns interpolation, routes, and drag visuals; GameSession still owns input mode, tile selection, reachability preview, and command dispatch. These gross counts are **not** net savings estimates. The archived plan explicitly deferred this cluster because of authority and renderer coupling; #171 left it for a future pass.

## Proposed boundary

1. Map the current input modes (`gizmo`, drag, click), reachability cache, waypoint controller, marker controller, renderer callbacks, network command dispatch, and scene signals. Identify which public GameSession methods and `@rpc` declarations must remain.
2. Extract tactical selection, destination preview, and drag state transitions into a focused child controller that receives explicit map/character lookup and command callbacks. Reuse `SessionCharacterMarkerController` for visual operations; do not duplicate its marker state. Keep command validation, authority decisions, and RPC declarations in GameSession or existing movement services.
3. Preserve drag cancellation, waypoint extension, invalid/unreachable destinations, click-to-move, GM/player authority, token lock, route animation, and 2D/3D parity. Avoid a broad rewrite of the movement protocol.
4. Count GameSession lines before/after and lower its ratchet in the same PR. Record actual net reduction for #504. If #509 plus this slice do not create at least 687 net lines of headroom, plan a separate additional extraction before closing #504; never raise the ceiling.

## Acceptance

- [ ] Before/after state and callback map shows a single owner for tactical drag state and no duplicated marker state.
- [ ] Existing movement, authority, waypoint, marker, and GameSession 2D/3D smoke tests pass; focused new tests cover cancel, unreachable destination, waypoint continuation, and authoritative dispatch.
- [ ] Full supported GdUnit and quality gates pass, GameSession net lines fall, and the ratchet is lowered in the same independently reviewed PR.
- [ ] #504 records the cumulative net reduction and any remaining gap before claiming its 100-line headroom target.

Risk: high (movement authority and scene/renderer interaction); complexity: large. Human plan approval and independent review are required.
