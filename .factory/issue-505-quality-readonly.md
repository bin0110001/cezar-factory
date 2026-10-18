Parent/dependency: #500 (project-owned Factory validation adapters). Related source-gate repairs: #502 requirements lint, #503 manifest, #504 GameSession ceiling. This issue covers read-only behavior of the existing quality check, not the live Cezar checkout.

## Reproduction
In an isolated clean clone of `main` SHA `bf43ef39`, `pwsh tools/gdscript-code-quality.ps1 -ProjectRoot .` changed 20 tracked GDScript files despite omitting `-FixTrailingWhitespace`. `git diff --ignore-all-space --exit-code` confirmed formatting-only edits; each generated edit was restored before switching branches. In `tools/gdscript-code-quality.ps1`, `Test-GdScriptFile` writes the file whenever `$fileChanged` is true, but its declared parameters do not include the advertised fix switch. A Factory validation stage would then leave the worktree dirty and invalidate its receipt.

## Plan
1. Make the default scan read-only: report trailing whitespace/BOM findings without rewriting source. Honor `-FixTrailingWhitespace` only when explicitly supplied, preserving current UTF-8 semantics.
2. Add subprocess fixtures with a trailing-whitespace file and BOM file. Assert byte-for-byte unchanged input on the default invocation, expected edits only in fix mode, and truthful exit/report behavior.
3. Run the focused fixtures and `git diff --check`; verify the full quality command no longer mutates the isolated project checkout even if other baseline findings remain.

## Acceptance criteria
- [ ] Default quality scan never changes tracked source bytes or creates an unrequested source file.
- [ ] Explicit fix mode removes the intended whitespace/BOM with test coverage and no unrelated edits.
- [ ] A failing check still exits nonzero, and #500 can consume it without dirtying the worktree.

Risk: medium; complexity: small. No extra plan approval for this source-only correction; independent review required. Do not use this issue to suppress the separate 26 baseline findings or edit the live checkout.
