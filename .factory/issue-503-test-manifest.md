Parent/dependency: #500 (project-owned Factory validation adapters). Related baseline repairs: #502 (requirements lint) and the GameSession ceiling issue linked from #500. Source-only; no live Cezar checkout changes.

## Problem
At `dev` SHA `b7385355`, `pwsh tools/gdscript-code-quality.ps1 -ProjectRoot .` reports 25 blocking `TestManifestContract` findings: 21 discovered GdUnit suites are unclassified and four manifest entries point to suites no longer under configured test directories. These failures predate any Factory adapter edit. The full-stage adapter must not suppress the quality gate or silently seed guessed classifications.

## Plan
1. Run the existing manifest linter/seed proposal read-only and compare each of the 21 new suites with neighboring suites and the test-harness trait policy. Review `pure`, `scene-tree`, network/resource and quarantine needs case by case.
2. Remove or correct the four stale entries only after checking whether the suites moved or were intentionally deleted; preserve meaningful tags/resources for renamed suites.
3. Update `test-manifest.json` with reviewed classifications. Do not weaken `SUITE_UNCLASSIFIED`/`SUITE_UNKNOWN` checks, and keep quarantine decisions explicit.
4. Run focused manifest scanner tests, the manifest linter and the full GDScript quality command. Confirm the manifest failures are gone, while reporting any independent GameSession size failure separately.

## Acceptance criteria
- [ ] All 21 discovered suites have justified manifest entries and all four stale entries are resolved without hiding real suites.
- [ ] Manifest lint emits no `SUITE_UNCLASSIFIED` or `SUITE_UNKNOWN` finding at the validated SHA.
- [ ] Existing negative tests still reject unclassified/unknown suites, and no quarantine behavior is silently changed.
- [ ] #500 cites the verified manifest revision before treating code quality as a release gate.

Risk: medium; complexity: medium. No extra plan approval for the source manifest repair; independent review required. This issue does not authorize changing GameSession's ceiling or the live checkout.
