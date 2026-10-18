Parent/dependency: #500 (project-owned Factory validation adapters). Related baseline repairs: #502 requirements lint, #503 suite manifest. Regression context: #162 and completed decomposition #171. No live checkout change is authorized.

## Problem
At `dev` SHA `b7385355`, the current GDScript quality command reports `GameSessionGrowth`: `scripts/gdscript/GameSession.gd` is 16,634 lines against the ratcheted 16,047-line ceiling, a 587-line violation. The same command is required by #500's honest full/verify validation stages. `CLAUDE.md` prohibits raising the ceiling as a convenience; prior #171 closed after earlier decomposition, so this is a new regression needing current-source investigation.

## Proposed plan for approval
1. Read `CLAUDE.md` and the complete archived `[WIP] GameSession Decomposition Plan.md`, including its implementation log. Compare current services/tests with the concrete candidates from #171: tactical drag/marker visuals, World Logic monitor/deployment/lens wiring, and PascalCase delegate wrappers. Check for overlap with open editor/combat issues before selecting a cohesive slice.
2. Record a before/after method and dependency map for the selected slice. Extract behavior into a focused service/controller with thin GameSession lifecycle/signal delegation; preserve RPC authority and scene binding. Do not mechanically remove lines or change the ceiling to mask the failure.
3. Add focused GdUnit regression coverage for the moved behavior, verify scenes/imports and existing relevant suites, then run the full quality and test gates. Lower the ratchet in the same reviewed change if the resulting file is smaller than the current ceiling.
4. Update the archived plan's implementation-progress record only as permitted by `CLAUDE.md` (the archive is provenance; if it must remain read-only, record current progress in the GitHub issue instead). Link #500 to the validated revision.

## Acceptance criteria
- [ ] At least 687 net lines of real behavior leave GameSession, bringing it below 16,047 with at least 100 lines of headroom; no ceiling increase or unrelated behavior deletion.
- [ ] New owner has focused tests, and existing scene/RPC behavior plus relevant GdUnit suites pass.
- [ ] `gdscript-code-quality.ps1` has no `GameSessionGrowth` finding at the reviewed SHA; manifest and requirements-lint failures remain tracked in #503/#502 until separately fixed.
- [ ] The exact reviewed extraction and resulting ceiling are recorded for #500 without touching the live Cezar checkout.

Risk: high; complexity: large. This is a proposed structural plan, not approval to implement or raise the limit. Human plan approval and independent review are required before source changes. Keep `factory:needs-help` until approved and the selected extraction boundary is confirmed.
