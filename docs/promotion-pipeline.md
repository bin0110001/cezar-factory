# Promotion pipeline

One host-driven loop carries a merged change to `stable` and recovers from its own failures. Nobody
runs promotion by hand, sets a channel pointer, or polls for a result. All validation runs on our own
compute; there is no hosted CI.

```
merge to dev ──► evidence gate ──► full suite ──► activate dev ──► canaries ──► stable ref ──► stable deploy
   (PR)          self-review or     in the Cezar    (pointer +       health,      fast-forward    runtime image,
                 approval           container       automations)     maintenance  via refs API    idle-gated
                       │                 │               │              │             │
                     blocked           failed         rolled back    rolled back   retried, then
                  (rechecked each    (SHA cached)    + quarantined  + quarantined   escalated
                      tick)                          + issue        + issue
```

## One owner

`factory_local_scheduler.py` (user timer `factory-local-promotion`, every 5 minutes after the previous
pass) is the only writer of channel pointers and of `origin/stable`. The `factory-autodeploy` timer
still runs, but only to reconcile the host to `stable` and to recover a deferred deploy. The Windows-side
`ship-*` skills are thin clients: they read this pipeline's state, they do not drive it.

The host has no `pwsh`, `node`, `gh`, or push credentials; the Cezar container has all of them and is
authenticated. So the promoter (Python, on the host) reaches them with `podman exec cezar`:

| Step | Runs | How |
|---|---|---|
| Review evidence, issues, stable ref | host promoter | `gh` through `ghCommand` (`podman exec cezar gh`) |
| Full suite | Cezar container | `scripts/release/validate-in-container.sh` (throwaway worktree at the exact SHA) |
| Pointer moves, rollback, quarantine | host promoter | release store is host-owned; the container cannot write it |
| Canaries | host promoter → Cezar API | schedule automations, polled to a verdict |
| Stable deploy | host | `factory-autodeploy.sh` (image build and restart are host-only) |

## Stages

1. **Evidence gate.** The merged PR for the SHA must target `dev` and satisfy the mode's review rule.
   A SHA without evidence is `blocked`, not `failed`: it is re-checked every tick, recorded once per
   distinct reason, and proceeds the moment evidence appears.
2. **Validation.** Every required check in `checks` must pass on a detached worktree of the exact SHA.
   A failure is cached for that SHA; a fix is a new SHA.
3. **Activate dev.** The exact artifact is staged and the coordinator moves the `dev` pointer,
   reconciles automations, and verifies each registered project. Reads wait up to 90 seconds for a
   restarting Cezar instead of failing at a fixed timeout.
4. **Canaries.** Each canary selected by the changed paths queues a schedule automation in Cezar against
   the new release and waits for it to finish. Any failure restores the previous `dev` release,
   quarantines the SHA, and stops the candidate.
5. **Stable.** After the soak period (and approval, in controlled mode) `origin/stable` is
   fast-forwarded with the GitHub refs API (`force=false`, so ancestry is enforced by GitHub).
6. **Stable deploy.** `factory-autodeploy.sh` fast-forwards the host, rebuilds the Cezar image only if
   `cezar/` changed, restarts it only when Cezar is idle, and activates the `stable` channel. A restart
   waits for no running runs; after the idle wait it defers (exit 25, retried next tick) and after
   `FACTORY_DEPLOY_MAX_DEFER_SECONDS` (default 2 hours) it restarts anyway so a busy queue cannot starve a
   deploy. The candidate is done when the `stable` pointer reaches its SHA.

Every candidate writes an immutable record under `release-store/promotion-records/` with the checks,
canary results, rollback outcome, and a digest (`schemas/factory-release/promotion-record.schema.json`).

## Self-improvement, with brakes

A failure at validation, activation, canary, or stable deploy opens one GitHub issue per failure
fingerprint (volatile SHAs, ids, durations, and timestamps are normalized away, so the same failure
comments on the open issue instead of duplicating it). The issue carries `factory:new`, so the normal
intake, plan, implement, and review workflows pick it up, and the fix arrives as an ordinary PR that goes
through this same pipeline. The previous release stays active throughout.

The circuit breaker counts consecutive failed candidates. At `maxConsecutiveFailures` it pauses automatic
promotion for `pauseSeconds` and opens a `factory:needs-help` escalation issue; this is the only point at
which the pipeline asks for a human. A successful stable deploy resets it, and so does
`factory_local_scheduler.py reset-breaker`.

Drift is checked every pass: the stable pointer against `origin/stable`, the host checkout, stable ahead of
dev, and what Cezar actually serves against the channel pointer. Drift that persists beyond
`drift.graceSeconds` opens an issue.

## Modes are data

`config/promotion-policy.json` carries both postures; `promotion.mode` selects one. There is no code path
that forks on the mode outside policy loading and the review decision.

| | `autonomous` (default) | `controlled` |
|---|---|---|
| Review evidence | approved review **or** a recorded self-review section in the PR | approved review only |
| Soak before stable | none | `soakSeconds` (default 1 hour) |
| `stable` moves | automatically after canaries | after `factory_local_scheduler.py approve --sha <sha>` |

To tighten the pipeline for a production posture, set `promotion.mode` to `controlled` (and review the
soak, canary, and breaker values) in a normal PR. Further controls, such as change windows, staged rollout
to other projects, or required canaries per risk class, extend the same file.

## Operating it

```bash
python3 scripts/release/factory_local_scheduler.py status [--sha <sha>]   # state of a candidate and the breaker
python3 scripts/release/factory_local_scheduler.py drift                  # disagreement report
python3 scripts/release/factory_local_scheduler.py approve --sha <sha>    # controlled mode only
python3 scripts/release/factory_local_scheduler.py reset-breaker
python3 scripts/release/factory_local_scheduler.py run --retry-failed     # retry a cached failure
journalctl --user -u factory-local-promotion.service
```

All commands take the same `--repo`, `--store`, `--config`, and `--registry` as the service unit; the
defaults match the host layout. Install the units with the commands in
`docs/factory-release-controller.md`.

## Limits

- Canaries prove the release loads, schedules, and runs `health` and `maintenance`. They do not yet run an
  implement or review workflow against a fixture issue; add one as a canary when a fixture exists.
- Validation runs inside the live Cezar container, so a heavy suite competes with running jobs. The
  container worktree lives under `/projects/.promotion` and is removed after each run.
- `stable` is a git branch, so a person with push access can still move it. The drift check reports it;
  it does not prevent it.
