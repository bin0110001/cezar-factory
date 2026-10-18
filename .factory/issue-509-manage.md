Parent: #504 (restore GameSession headroom) and tracking parent #188. This is a proposed high-risk structural slice; source implementation requires human plan approval. Related existing owner: `scripts/gdscript/ManageCharactersPanel.gd` and `ManageCharactersService.gd`. Do not edit the registered Cezar checkout.

## Current evidence

At `dev` SHA `b7385355`, GameSession lines 2982–3719 contain 54 top-level functions and about 738 gross lines for Manage Characters and adjacent Player Actions/control-access orchestration. Many pure policies and panel rendering paths have already moved to the existing service/panel, so gross lines are **not** a savings estimate. The archived decomposition plan's 1,080-line estimate is stale.

## Proposed boundary

1. Inventory every function in that span and its scene-signal, network, persistence, and panel dependencies. Separate Manage Characters handlers from unrelated Player Actions, build-access, and music handlers; do not move adjacent code merely because it is contiguous.
2. Move remaining dialog lifecycle, list/selection presentation, and controller/owner interaction into `ManageCharactersPanel`, with explicit callback or signal boundaries for GameSession's authoritative save, delete, network broadcast, and character-editor navigation. Reuse `ManageCharactersService` for policy; do not create a second policy source.
3. Keep GameSession's authoritative state mutation, RPC entrypoints, and thin signal wiring. Preserve current scene node paths and existing public method names where tests or `.tscn` signal bindings call them.
4. Count GameSession lines before/after and lower the ratchet in `tools/gdscript-code-quality.ps1` to the new line count in the same PR. Record actual net reduction for #504; do not claim the parent threshold is met by this slice alone.

## Acceptance

- [ ] A before/after function ownership map identifies moved methods and retained GameSession callbacks.
- [ ] Manage Characters selection, owner/controller changes, card actions, save/delete, and permission outcomes remain behaviorally identical.
- [ ] Existing `ManageCharactersPanelTest`, `ManageCharactersServiceTest`, GameSession character tests, relevant scene smoke tests, and the full supported quality/GdUnit gates pass.
- [ ] GameSession net lines fall and the ratchet is lowered in the same reviewed PR; #504 records the exact reduction.

Risk: high (scene/UI and authoritative persistence boundaries); complexity: medium. No implementation until the proposed extraction boundary is approved. Independent review is required.
