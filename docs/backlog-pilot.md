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

## Predeclared criteria (fixed before the live shadow period is read)
Enforcement may become opt-in for a repository only when all of these hold over that repository's shadow window
(at least 20 accepted changes):

| Criterion | Threshold | Source |
| --- | --- | --- |
| Conflict recall (file overlap) | >= 0.85 | `conflictConfusion`, replay table above |
| Conflict precision | >= 0.70 | same |
| Unknown predictions | reported separately, never counted as safe | `conflictConfusion` |
| Accepted throughput vs shadow baseline | no regression | `rolloutSummary(...).regression.throughput` |
| Merge debt per completed change | no regression | `rolloutSummary(...).regression.mergeDebt` |
| Source branches / edits lost on any fault fixture | 0 | fault coverage below |
| GitHub Actions compute / Langfuse required | none | local compute only |

Rollback triggers (unset `CEZAR_BACKLOG_SCHEDULING`): either regression flag true, any lost source work, or a
deferral that blocks Ready P0/P1 work without a visible reason.

## Fault-injection coverage
Each fixture is a deterministic test in `cezar/packages/cezar/src/server/backlog/`; none uses GitHub Actions.

| Fault | Test |
| --- | --- |
| GitHub unavailable | `github-sync.test.ts` "queues through a GitHub outage and reconciles deterministically" |
| Stale projection / stale revision | `backlog.test.ts` "rejects stale revisions"; `github-sync.test.ts` "ignores remote metadata older" |
| Duplicate webhook / duplicate scheduler | `scheduling.test.ts` "never double-dispatches ... two scheduler processes"; `obligations-drift.test.ts` "idempotent across replays" |
| Concurrent reorder / racing edit | `backlog.test.ts` "breaks rank collisions"; `github-sync.test.ts` "racing our write", "simultaneous edits" |
| Agent crash / expired lease | `scheduling.test.ts` "expires crashed holders"; `obligations-drift.test.ts` "expired lease or reservation" |
| Malformed manifest | `registry-binding.test.ts` "rejects invalid and stale revisions, and treats corruption as unknown" |
| Failed reconciliation | `obligations-drift.test.ts` "needs an integration agent", "bounds replanning ... asks a human" |
| Offline external host / unreadable running work | `registry-binding.test.ts` "fails closed when running work cannot be read" |
| Subscription / quota exhaustion | `scheduling.test.ts` "distinct statuses" for quota and capacity-unknown |

Scheduling only decides when to start work; it never deletes or rewrites branches, so a failing fixture can defer
or flag work but has no path that discards a source branch.

## Defaults, privacy and retention
- Default: **off**. `shadow` records would-be decisions only. `enforce` is per-repository opt-in. `CEZAR_BACKLOG_SYNC=on`
  additionally allows GitHub write-back of backlog metadata.
- The projection stores issue numbers, titles, priorities, ranks, file paths and audit entries in Cezar's local
  SQLite store; nothing is sent to a third party. Langfuse (#128/#129) is optional and unused here.
- Audit entries are kept with the projection; deleting the backlog store resets it without touching issues or branches.

## Runbook
1. Enable: set `CEZAR_BACKLOG_SCHEDULING=shadow` in the Cezar service unit, reload and restart it.
2. Observe: `podman logs cezar | grep backlog-scheduling`; check `GET /api/v1/backlog` and `/backlog/recommendation`.
3. Baseline: feed real counts to `rolloutSummary` and compare against the criteria table.
4. Opt in: set `enforce` for one repository; enable `CEZAR_BACKLOG_SYNC=on` only after a clean shadow window.
5. Roll back: remove the variable (kill switch), `systemctl --user daemon-reload && systemctl --user restart container-cezar.service`.
   Delivery through dev/stable (#60) is unaffected either way.

## Decision on default enablement
**Do not enable by default yet.** Replay evidence supports the file-overlap rule (recall 0.91 / 1.00, precision
0.79 / 0.76), but oracle manifests overstate real planner quality, the dependency misses need #159, and no live
throughput or merge-debt baseline exists. Shadow stays on in the pilot; revisit when the criteria table can be
filled from a live window.

## Rollout status (live)
Not yet run: a live opt-in `shadow` period in either project, throughput/merge-debt baselines (`rolloutSummary`
needs real counts), and adaptive tuning. Enable shadow with `CEZAR_BACKLOG_SCHEDULING=shadow`, review the
`[backlog-scheduling:shadow]` log lines, then move a project to `enforce`. The kill switch is unsetting the variable.
