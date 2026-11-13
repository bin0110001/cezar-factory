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
   the new release and waits for it to finish. Cezar runs one job at a time, so a canary can queue behind real
   work: only its running time counts against `timeoutSeconds`, and the wait in the queue has its own
   `queueTimeoutSeconds` (default 2 hours). Any failure restores the previous `dev` release,
   quarantines the SHA, and stops the candidate.
5. **Stable.** After the soak period (and approval, in controlled mode) `origin/stable` is
   fast-forwarded with the GitHub refs API (`force=false`, so ancestry is enforced by GitHub).
6. **Stable deploy.** `factory-autodeploy.sh` fast-forwards the host, rebuilds the Cezar image only if
   `cezar/` changed, restarts it only when Cezar is idle, and activates the `stable` channel. A restart
   waits for no running runs; after the idle wait it defers (exit 25, retried next tick) and after
   `FACTORY_DEPLOY_MAX_DEFER_SECONDS` (default 2 hours) it restarts anyway so a busy queue cannot starve a
   deploy. The candidate is done when the `stable` pointer reaches its SHA.

Every candidate writes an immutable record under `~/.local/share/cezar-factory/promotion-records/` with the checks,
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
dev, and what Cezar actually serves against the channel pointer. Stable ahead of dev is drift only when
stable's SHA has no healthy promotion record (a dev canary rollback leaves it legitimately ahead). The Cezar
probe retries for 45 seconds; an unreadable probe is `unknown`, not drift, and opens an issue only after it
persists past twice `drift.graceSeconds`. Drift that persists beyond `drift.graceSeconds` opens an issue.

## Modes are data

`config/promotion-policy.json` carries both postures; `promotion.mode` selects one. The default is
`autonomous` (a solo-maintainer repo cannot produce an independent approval); a Production Run switches
the reviewed config to `controlled`. There is no code path that forks on the mode outside policy
loading and the review decision.

| | `autonomous` | `controlled` |
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
python3 scripts/release/factory_local_scheduler.py health                 # is promotion landing? ok | degraded | stalled
python3 scripts/release/factory_local_scheduler.py drift                  # disagreement report
python3 scripts/release/factory_local_scheduler.py approve --sha <sha>    # controlled mode only
python3 scripts/release/factory_local_scheduler.py reset-breaker
python3 scripts/release/factory_local_scheduler.py run --retry-failed     # retry a cached failure
journalctl --user -u factory-local-promotion.service
```

All commands take the same `--repo`, `--store`, `--config`, and `--registry` as the service unit; the
defaults match the host layout. `--store` is the scheduler state root (`~/.local/share/cezar-factory`); the
release store the controller uses is `<store>/release-store`, so never pass the release store itself. Install the units with the commands in
`docs/factory-release-controller.md`.

## Knowing it is failing

A host that fails every candidate looks "up" to every other check, so three things make failure visible:

- **The record says what failed.** A failed check keeps the head and the tail of its output (a suite prints its
  failures at the end), and `failureLines` lists the `FAIL`/`FAILED`/error lines. The failure reason, and so the
  `[promotion]` issue, carries the first few instead of only "exit code 1".
- **`health`** reports the last healthy promotion, its age, the failures since, and a state: `degraded` is any
  failure since the last healthy candidate, `stalled` is three or more (the breaker's threshold) or none healthy
  for a day while candidates fail. Stopping without failing counts too: a candidate `blocked` at the evidence gate
  for an hour, or drift past its grace period (the host is not on the promoted release), is `degraded`, and either
  lasting six hours is `stalled`. `reasons` names the cause. `ship-loop.ps1 -Action Health` prints it and exits 4 when stalled; the
  `ship-fix` skill runs it first.
- **Linux before merge.** The suite passes on Windows and can fail in the Linux promotion container (14 candidates
  failed for days on Linux-only problems). `ship-loop.ps1 -Action Validate` runs the host's own
  `validate-in-container.sh` for a pushed commit in a throwaway worktree, prints the failing lines, and changes no
  release state. `ship-fix` runs it before merging.

## Candidates with no changes

A candidate is validated by the checks that match the paths changed since the active `dev` release. A candidate whose tree is
identical to that release, such as a merge-only commit that reconciles history, has no changed paths: there is nothing to
validate because the same tree already passed. It is staged and activated so the pointers follow the branch, its record says
`validation: skipped`, and it goes on to the canaries and `stable` like any other candidate. It is not a failure and does not
count toward the circuit breaker.

`stable` must stay an ancestor of `dev`. Anything committed straight to `stable` (the label-audit bot did this twice on
2026-11-09) makes every later stable promotion fail with `Update is not a fast forward (HTTP 422)`; reconcile it by merging
`stable` into `dev` with a merge commit (a squash merge drops the second parent and does not help).

## Environment preflight

Before any validation is spent on a candidate, the promoter runs each command in `promotion.preflight`. The shipped
one is the model probe, run inside the Cezar container, because every canary that has an agent step needs the model
endpoint. A failed preflight leaves the candidate `blocked` with the reason, exactly like missing review evidence: it
is re-checked every tick, shows in `health`, opens one `factory:needs-help` issue after
`promotion.blocked.escalateSeconds`, and the same SHA proceeds as soon as the environment is back. Nothing is
validated, activated, rolled back or quarantined, and the breaker does not move.

On 2026-11-12 a reboot left the Cezar container unable to reach LiteLLM, and two good releases were validated,
activated, failed the `maintenance` canary's model check, and were rolled back and quarantined before anyone looked.

## Not the candidate's fault

Three things used to be recorded as a failed candidate although the change was fine:

- **A check killed from outside** (exit 137 or 143: a container restart, the OOM killer). The candidate is `interrupted`, not
  `failed`: no breaker count, no issue, and the next tick validates the same SHA again, up to twice. While a suite runs the
  promoter keeps its PID in `<store>/validation-in-progress`, and `deploy-cezar-runtime.sh` counts that as a busy Cezar, so a
  deploy defers its restart instead of killing the suite.
- **A canary that hits a transient GitHub error** (rate limit, 502/503/504, a dropped connection, truncated JSON; the pattern is
  `promotion.canaries.transientPattern`). The canary is run once more before the release is rolled back and quarantined; the
  record keeps the first reason in `retriedAfter`.
- **A candidate with no changed paths** (above).

## When the pipeline cannot fix itself

The promoter and the deployer run from the host checkout, which is on `stable`. A fix to the gate policy, the promoter, or a
deploy script therefore has to pass through the thing it fixes. On 2026-11-12 the `autonomous` policy could not be promoted
because the host still enforced `controlled`, and a fix to the reconcile step could not deploy because the old step ran first;
`health` said `ok` the whole time.

Detection is automatic now. `health` is `degraded` after an hour of a blocked candidate or of drift and `stalled` after six, and
a candidate blocked longer than `promotion.blocked.escalateSeconds` (default one hour) opens one `factory:needs-help` issue,
`[promotion] candidate blocked at the evidence gate`. Drift is reported when it appears or changes and then every six hours,
not on every tick.

Recovery, by the stage that is stuck. Each needs the owner's approval, because it is a manual action on shared state:

| Stuck at | How to tell | Recovery that does not depend on the broken stage |
|---|---|---|
| Evidence gate | `status` shows `blocked` with the gate's reason | If the PR really lacks its review evidence, add it; the same SHA proceeds on the next tick. If the gate policy itself is wrong on the host, promote the fix with `scripts/release/promote-stable.ps1` from a clean checkout of the merged `origin/dev` head. |
| Validation | `status` shows `failed` at validation | Reproduce with `ship-loop.ps1 -Action Validate`, fix on `dev`; a fix is a new SHA. `run --retry-failed` re-runs a SHA whose failure was environmental. |
| `stable` ref | `[promotion] stable-promotion failed`, HTTP 422 | Something was committed to `stable`. Merge `stable` into `dev` with a merge commit; the next candidate fast-forwards. |
| Environment preflight | `status` shows `blocked` with `environment preflight model-endpoint failed` | Fix the environment; nothing in the repo is wrong. If Cezar cannot reach `host.containers.internal` after a reboot, the containers started before the host had its address: `podman unshare --rootless-netns ip -4 addr` shows a `169.254.x.x` address instead of the LAN one. Stop every container that is on a Podman bridge network (other apps on the host share that namespace), then start them again. The permanent fix is ordering the container units after the system network-online target: run `scripts/deploy/install-boot-order.sh` on the host (`check` and `remove` modes exist; it changes only that user's unit drop-ins and restarts nothing). |
| Host deploy | `journalctl --user -u factory-autodeploy.service` shows the failing step | `promote-stable.ps1` moves `origin/stable`; the next autodeploy run fast-forwards the host first and then uses the new scripts. |

`promote-stable.ps1` runs the full suite and only fast-forwards, but it skips dev activation and the canaries, so the `dev`
pointer lags until the next candidate passes. Use it to get a fix to the delivery path onto the host, not as a routine.

## Limits

- Canaries prove the release loads, schedules, and runs `health`, `repair-probe` (a model-free rehearsal of the repair controller) and `maintenance`. They do not run an
  implement or review workflow: those are driven by GitHub issue and PR events, so a faithful canary needs a
  dedicated fixture issue and a sandbox repository, otherwise every promotion would create real labels and PRs.
  The implement stage's own code paths (startup preflight, changed-file selection, result validation) are
  covered by the full suite that gates every candidate, including `tests/validation-adapters.ps1`. Add a
  workflow canary when a sandbox project exists; the policy accepts it as one more `canaries.items` entry.
- The deploy shell tests (`tests/test-*.sh`) run inside `tests/run-tests.ps1` whenever a POSIX `bash` is on the
  path, which includes the Cezar container that validates each candidate.
- Validation runs inside the live Cezar container, so a heavy suite competes with running jobs. The
  container worktree lives under `/projects/.promotion` and is removed after each run.
- A commit made on the root `stable` checkout inside the Cezar container (a run that committed in the root worktree) does not
  block the stable deploy: `reconcile-container-git-metadata.sh` keeps it under `refs/factory/displaced/<sha>`, warns, and moves
  the ref to the promoted commit. Look there if work seems to have vanished from the root checkout.
- `stable` is a git branch, so a person with push access can still move it. The drift check reports it;
  it does not prevent it.
