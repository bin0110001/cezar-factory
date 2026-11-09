# Backlog scheduling pilot results (#202; epic #192)

## Method
`cezar/packages/cezar/scripts/pilot-replay.mjs <repo> <ref> [commits]` clones the repo locally (source repos get
no new objects), takes the most recent first-parent single-parent commits, and for each **adjacent** pair asks:
the analyzer predicts from each commit's true changed files (oracle manifests, confidence 1.0), and
`git merge-tree` reports whether the newer change, rebased onto the older commit's parent, actually conflicts
with the older one. Results feed `conflictConfusion`. Only adjacent pairs are used because a later commit can
depend on anything between, which would read as a false conflict.

What this measures: how well the deterministic **file-overlap rule** predicts real textual conflicts in
historical concurrent-looking work. What it does not measure: the planner's own prediction quality (the manifests
here are perfect), live dispatch behaviour, or semantic conflicts that merge cleanly.

## Results (run 2026-11-03)
| Repository | Ref | Pairs | TP | FP | FN | TN | Recall | Precision |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cezar-factory | origin/dev @ 8e79928 | 66 | 30 | 8 | 3 | 25 | 0.909 | 0.789 |
| TableFlux (ArtificersVault) | HEAD @ 02995e9 | 65 | 22 | 7 | 0 | 36 | 1.000 | 0.759 |

- **Recall** is high: same-file overlap catches nearly every real conflict. The 3 cezar-factory misses are
  file-disjoint pairs where the newer commit depends on content the older one introduced (a dependency, not a
  merge accident), which the dependency graph (#159), not the overlap rule, is meant to catch.
- **Precision** ~0.76-0.79: about one in four predicted file overlaps merge cleanly (distant hunks in one file).
  That is the cost of serialising same-file work; it is conservative, not unsafe. Hunk-level or contract-level
  evidence is the lever for improving it.
- `unknown` was 0 because oracle manifests are always `complete`; real planner output will produce `unknown`
  and that is reported separately, never counted as safe.

## Rollout status
Not yet run: a live opt-in `shadow` period in either project, throughput/merge-debt baselines (`rolloutSummary`
needs real counts), and adaptive tuning. Enable shadow with `CEZAR_BACKLOG_SCHEDULING=shadow`, review the
`[backlog-scheduling:shadow]` log lines, then move a project to `enforce`. The kill switch is unsetting the variable.
