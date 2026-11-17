# Release migration inventory (#639)

What exists today, what the incidents tell us, and where the new single-active candidate engine (epic #588) must not duplicate
the live promoter. Sources: `docs/promotion-pipeline.md`, `config/promotion-policy.json`, `AGENTS.md` and the incident issues.
This is a documentation inventory; live repository settings were not queried (see "Gaps").

## Refs and protections

| Ref | Writer today | Protection | Notes |
| --- | --- | --- | --- |
| `dev` | implementation PRs, squash-merged by the owning job | none: the repository has no branch rules on `dev` (`AGENTS.md`), so GitHub rejects `--auto` merges | stays writable while a candidate is validated |
| `origin/stable` | only the host promoter (`factory_local_scheduler.py`) | not verified here | fast-forwarded through the GitHub refs API with `force=false`, so GitHub enforces ancestry |
| channel pointers (`dev`, `stable` channels) | only the promoter (release store is host-owned) | host file ownership | a person with push access can still move `stable`; the drift check reports it |
| `refs/factory/displaced/<sha>` | `reconcile-container-git-metadata.sh` | n/a | keeps a commit made on the root `stable` checkout |

The new engine adds `refs/rc/<id>/<rev>` (create-only) and an optional regression pointer (`docs/release-snapshot.md`); it never
force-updates a ref.

## Release jobs (all local; no GitHub Actions)

| Job | Owner | Role |
| --- | --- | --- |
| `factory-local-promotion` timer | host promoter | evidence gate, validation on the exact SHA, dev activation, canaries, stable fast-forward |
| `factory-autodeploy` timer | host | reconciles the host to `stable`, recovers a deferred deploy |
| `promote-stable.ps1` | break-glass | manual path for a Production Run or a dead promoter |
| `ship-loop` / `ship-*` skills | Windows clients | thin clients that read pipeline state |
| `validate-in-container.sh` | Cezar container | full suite in a throwaway worktree at the exact SHA |

## Incident map

| Incident | Failure mode | Owning mechanism today | New engine | Status |
| --- | --- | --- | --- | --- |
| #550, #551 candidate blocked before validation | a dev SHA has no merged PR with a satisfied review gate (approved review or recorded self-review) | promoter stage 1 "evidence gate": the SHA is `blocked`, not `failed`, re-checked every tick and recorded once per reason | `release_promotion.authorize` expresses the same rule (evidence, approval or auto) as a pure decision | handled by the existing promoter; **do not add a second evidence gate** |
| #559 release drift persists | stable deploy deferred because Cezar was busy | `deploy-deferred` outcome, max-defer window, drift report names the deferral | ref movement and activation are separate phases; `detect_drift` compares ref, serving and last confirmed-active | handled; the new engine must keep activation separate, not re-implement deferral |
| #560 activation failed on a quarantined release | a quarantined candidate reached activation | quarantined release is `unchanged` unless run with `retry_failed`, which revalidates first | `PromotionLedger` quarantines the SHA on a failed activation | handled; **gap**: two quarantine lists exist (below) |
| #586 validation failed | host pid/thread exhaustion, not the candidate | validation adapter retries a start-up failure once and records it | `release_verification.classify` separates infrastructure failure, bounded reruns and `unknown` | handled; new engine should reuse the same classification |

## Gaps (named, not solved here)

1. **Two quarantine lists.** The promoter's release store and the new `PromotionLedger.quarantine` are separate. Before a project
   runs on `new`, they must read one source, or a quarantined SHA could be promoted by the other path.
2. **Live protection of `stable` is unverified.** Query it from a workflow step (`gh api` through the Cezar container) and record
   the result; the library cannot check it.
3. **The new modules are not wired into the promoter.** `release_pipeline_config`, `release_candidate_store`, `release_triggers`,
   `release_snapshot`, `release_verification`, `release_repair`, `release_promotion` are libraries; adoption is gated by the
   rollout flags in `docs/release-rollout.md` and needs workflow `command:` steps.
4. **No second state machine.** The candidate store models candidate lifecycle; the promoter models per-SHA promotion. Adoption must
   map one onto the other (a candidate promotes through exactly one promoter pass) rather than run both independently.
