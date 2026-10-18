The strict test-manifest check fails on `dev` because 21 suites added after the last manifest update are unclassified, four entries point to removed suites, and five scanner-derived classifications have drifted. This reconciles the manifest with the current scanner output while preserving the manually maintained `requires:full-assets` classification.

Validation:
- `Invoke-TestManifest.ps1 -Action validate -Root . -Strict`: 0 errors, 0 warnings.
- `Invoke-Pester tools/tests/test-harness-scanner.Tests.ps1`: 34 passed, 0 failed.
- `gdscript-code-quality.ps1`: the manifest errors are resolved; its sole remaining issue is the GameSession growth ceiling tracked by #504.
- `git diff --check` passes and the quality command did not change the worktree.

Closes #503. Part of #500. Independent review is required before merge; this source change does not update the registered Cezar checkout.
