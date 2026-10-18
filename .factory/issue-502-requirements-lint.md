Parent/dependency: #500 (project-owned Factory validation adapters). This issue is an independent source repair; no live Cezar checkout change is authorized. Related Factory release gate: [cezar-factory#39](https://github.com/bin0110001/cezar-factory/issues/39).

## Problem
At `dev` SHA `b7385355`, `pwsh tools/requirements-lint.ps1 -ProjectRoot .` fails with four findings: two references to the now-archived `Planned Features/FEATURE_PRIORITY.md`, one to archived `Completed/Package Manifest Auto-Scan.md`, and a `MissingFeaturePriority` error. `CLAUDE.md` says the GitHub Issues cutover made the former requirements tree read-only provenance, while this checker still applies active-backlog rules to it. The same four failures reproduce on `main` SHA `bf43ef39`. A Factory full-validation adapter cannot pass this required gate by ignoring its exit code.

## Plan
1. Read the cutover section of `CLAUDE.md`, `tools/requirements-lint.ps1` and its tests. Define the active checks that remain meaningful for archived Markdown and current GitHub-backed work without rewriting archived files.
2. Update the checker to distinguish archived provenance references from broken live paths, remove the obsolete priority-list requirement, and preserve useful real dangling-link diagnostics. Keep the command read-only.
3. Add fixtures for an archived valid reference, a real missing live reference, and a repository with no legacy priority file. Run the checker on both `dev` and `main` snapshots (or record a concrete branch-drift reason), plus focused tests.

## Acceptance criteria
- [ ] The checker exits 0 on the current backlog cutover layout without restoring or editing archived backlog files.
- [ ] A real broken live reference still fails with a precise path; archived provenance is handled explicitly.
- [ ] The check makes no source edits and its negative fixtures pass.
- [ ] #500 records the validated checker revision before using it as a full-stage gate.

Risk: medium; complexity: small. No extra plan approval for this source-only repair; independent review required. Work only in an isolated branch and keep #500/#501 rollout boundaries intact.
