# Factory stabilization plan

Working path until the core loop is reliable. Started 2026-11-11. Tick a box only when the change is
merged to `dev` (code) or done and verified (operations). Add findings under the item they belong to;
do not start a second plan.

**Rule while this plan is open:** no new feature work enters implementation. The feature backlog
(about 40 `factory:ready` issues, 8 epics) waits until the exit criteria at the bottom are met.

## What is actually wrong

Two audits of the code, the live host, and the 89 open issues on 2026-11-11 found two structural causes.

### 1. Work stalls because the Factory is edge-triggered and nothing reconciles

Every automation except intake fires on an `issue.labeled` *event*, once. If that event is spent
without a transition (run crashed before `start`, agent no-op, automation paused, refused route),
the label stays and nothing ever looks at it again. The sweeps that are supposed to catch this each
cover a slice and have their own holes. On 2026-11-11 **no open issue had a verifiably live consumer**:

| Stuck group | Count | Why nothing picks it up |
|---|---|---|
| `factory:ready`, never re-emitted | 31 | Implement automations are paused on the host; the stale refresher only ever re-triggers the 2 oldest issues |
| `factory:ready` + `factory:auditing` | 7 | A stale `auditing` marker beside a state label is skipped by every sweep, permanently |
| `factory:new` without `type:*`/`risk:*` | 10 | Intake selection requires both labels; the promoter files its failure issues with neither, so "self-healing" issues are never read |
| `factory:blocked` | 15 | No automation consumes it and nothing re-checks whether the blocker closed |
| `factory:needs-help` | 9 | No timeout or reminder; most carry a boilerplate "architectural decision" with no question in it |
| `factory:investigate` | 2 | Event spent; starved by the refresher |

There is no single check that says "every open issue is in exactly one state that has an owner and a
deadline".

### 2. Deployed scripts break because the first real execution is after merge

Of about 33 fix commits in the last 110, **none** was a syntax error or a renamed parameter. They were:
runtime logic that only shows with real state (9), Windows-versus-Linux differences (7), generated
`.factory` scratch dirtying a gate (6), live `gh` behaviour (5), cross-language or host contracts (4),
defective tests (3), gate policy (2). The gates miss them because:

- The suite runs on Windows before merge; the first Linux run is the promoter, after merge.
  `ship-loop -Action Validate` exists but is advisory.
- Seven workflow scripts are never executed by any test or canary before production
  (`route-plan-or-default`, `collect-environment-state`, `prepare-implementation`,
  `ensure-implementation-result`, `ensure-pr-closes-issue`, `validate-reviewed-head`, `hindsight/recall`).
- Nothing parse-checks scripts (the one `ParseFile` call discards its errors and is not recursive), and
  nothing checks workflow `command:` steps against script `param()` blocks. No breakage yet, but unguarded.
- Three of 15 workflows have a canary; canaries depend on live GitHub and roll back on transient errors.
- `health` reports `ok` while the stable deploy is failing and the host is not on `stable`.

### 3. The lifecycle is hard-coded in a dozen places

The states, who consumes them, and which transitions are legal are repeated as literal label lists in
`route-state.ps1`, `refresh-stale-workable.ps1`, `maintain-repository.ps1`, `select-intake-issue.ps1`,
`sync-issue-delivery.ps1`, `recover-audit-reservations.ps1`, `reconcile-backlog.ps1`, every
`automations/*.json` filter, the Cezar stall detector, and `docs/lifecycle.md`. They already disagree
(the doc says the router sets `factory:blocked`; it never does), and each new sweep adds another copy.
A project cannot change the process, for example adding a technical-design step with manual sign-off
for risky work, without editing all of them. Cause 1 is partly a symptom of this: a state can exist in
one list and be missing from the list that would have given it a consumer.

## Phase 0: unstick what is broken today

- [x] **0.1 Stable deploy refuses every candidate (#432, #377, #375).** The container's root `stable`
  ref sits on `21bd05f`, a label-audit bot commit that is not in `origin/stable`, so
  `reconcile-container-git-metadata.sh` refuses the non-fast-forward. Make the script preserve a displaced
  local commit under `refs/factory/displaced/*` and continue, instead of failing forever.
- [ ] **0.2 Find what committed on the root `stable` checkout** (also the cause of #427 and PR #301) and
  make it impossible: Factory runs must never commit on the root worktree, `stable`, or `main`.
  `main` already carries 3 bot commits that `dev` lacks.
- [x] **0.3 `health` must not say `ok` while the stable pointer lags `origin/stable`,** a stable deploy
  is failing, or a candidate has been `blocked` at the evidence gate for hours. On 2026-11-12 it said `ok`
  for 13 hours while nothing could be promoted.
- [x] **0.4 Close resolved and superseded issues and stale PRs** (2026-11-11; list in the log below).
- [x] **0.5 Fix contradictory labels** (stale `factory:auditing`, #102, #164).
- [ ] **0.6 Bazzite `/var/home` is about 96% full** (blocks #129, and a full disk stops the promoter).
  Needs the owner: free space or move the store.
- [x] **0.7 After 0.1 lands on the host:** confirm the stable pointer reaches `origin/stable`, then
  `reset-breaker` (owner approval) and close #432, #377, #375.

- [ ] **0.8 The delivery path cannot repair itself.** The promoter and the deployer run from the host
  checkout on `stable`, so a fix to the gate policy, the promoter, or a deploy script has to pass through
  the very thing it fixes. On 2026-11-12 this deadlocked twice at once: the `autonomous` policy (#436) was
  blocked by the `controlled` policy still on the host, and the reconcile fix (#438) could not deploy
  because the old reconcile script ran first. It was cleared by hand with `promote-stable.ps1`. Needed: a
  blocked or failing delivery path escalates within the hour instead of waiting silently, and a documented,
  tested recovery for each stage (gate, validation, stable ref, host deploy) that does not depend on the
  stage that is broken.

- [ ] **0.9 A deploy restart kills a validation in progress.** The promoter runs the full suite inside the
  Cezar container with `podman exec`; autodeploy waits only for Cezar runs to be idle before it restarts the
  container, so a restart during validation kills the suite (exit 137), and the failure is cached for that
  SHA and counts toward the breaker. Seen on `4bb870a` at 12:55Z on 2026-11-12. The two timers need one
  lock, or the deployer must treat a running validation as busy, and a killed check must be retried, not
  cached.

## Phase 1: no state without an owner and a deadline

- [x] **1.1 Intake takes promoter-filed issues.** The promoter labels its issues `type:bug` and
  `risk:medium`; intake selection no longer silently drops a `factory:new` issue that lacks a type or risk
  label (it is selected and classified, or reported, never ignored).
- [x] **1.2 Fair stale refresher.** Rotate by least-recently-updated instead of always the 2 oldest by
  creation date, so every workable issue is re-triggered in turn.
- [x] **1.3 Stale `factory:auditing` marker is cleared** when it sits beside a lifecycle state past the
  reservation timeout.
- [ ] **1.4 The lifecycle is configuration, not code.** This is the foundation for the rest of the
  phase; items 1.5 to 1.10 are built on it instead of adding more hard-coded lists.
  - [x] **1.4a Define the model** in `policies/lifecycle.json` with a schema: for every state its kind
    (automated, human gate, marker, terminal), owner (which workflow, or which human role), legal exits
    with the event that causes each, maximum dwell, and what happens on timeout (re-trigger, escalate,
    report). Guards on a transition are data too (for example "requires exactly one `complexity:*`").
  - [x] **1.4b Ship the current process as the default profile**, with no behaviour change, and a
    static test that the model is sound: every non-terminal state has an owner, an exit, and a deadline;
    every exit targets a defined state; every automated state has an automation that consumes it.
  - [ ] **1.4c One loader** (`scripts/lifecycle-lib.ps1`) that every script uses. Replace the literal
    label lists script by script (`route-state`, the refresher, maintenance, intake selection, delivery
    sync, audit recovery, reconciler), each behind the existing tests. A test fails on any new
    hard-coded `factory:*` state list outside the policy.
  - [ ] **1.4d Generate, do not hand-write,** the `automations/*.json` filters and the state table in
    `docs/lifecycle.md` from the model, so a consumer cannot be missing for a state the model declares.
  - [ ] **1.4e Profiles and per-project overrides.** A project selects a profile and may override it in
    its registry entry; steps can be conditional on risk or type. Prove it with a second profile:
    `factory:tech-design` followed by a manual sign-off gate before `factory:ready` for `risk:high`
    work, enabled by configuration alone with no script edits.
  - [ ] **1.4f Cezar reads the same model** (stall detector, backlog lanes, Decisions screen) instead of
    its own copy of the states.
- [ ] **1.5 One invariant sweep in `factory-maintenance`** driven by that model. Repairs what is
  mechanical (two state labels, no state label, `ready` without exactly one complexity label, `blocked`
  whose blockers all closed, `pr-open` whose PR closed unmerged) and lists everything past its deadline in
  one rolling "Factory stall report" issue. Replaces the per-slice sweeps over time.
- [ ] **1.6 Crash recovery for `factory:working`.** Verify and fix the `CEZAR_API_URL` versus
  `CEZ_API_URL` mismatch that makes "latest run failed" detection fall back to a 24-hour wait; stop
  comments from resetting the clock (use time in state).
- [ ] **1.7 Watchdog covers issue-scoped runs** (plan, implement, review, fix, investigate), not only the
  four housekeeping workflows.
- [ ] **1.8 `needs-help` requires a real question.** An escalation without a structured decision returns
  to `factory:needs-plan`; open decisions get a weekly digest instead of silence.
- [ ] **1.9 PR sweep.** A `CONFLICTING` PR into `dev` routes its issue to `factory:changes-requested`;
  drafts and PRs without a closing keyword are reported.
- [ ] **1.10 Bound the investigate, re-plan, implement loop** (today only the direct retry is capped).
- [ ] **1.11 Re-enabling an automation reconciles existing labels** instead of baselining to "now"
  (make every automation level-triggered, as intake already is with `fullReconcileHours`).
- [ ] **1.12 Correct `docs/lifecycle.md`** where it disagrees with `route-state.ps1` (`blocked` is never
  set by the router; `human-review` has no writer).
- [ ] **1.13 Deploy and use the stall detector from #434** (`/api/v1/dependency-graph/stalls` returns 404
  on the host until `stable` moves); teach it complexity labels and script-side gates.

## Phase 2: breakage is caught before merge

- [x] **2.1 Static contract test** in `tests/run-tests.ps1`: every `.ps1` parses (recursive, errors
  fail), every `.py` compiles, every `.sh` passes `bash -n`, and every workflow `command:` step names an
  existing script and passes only declared parameters, including all mandatory ones. Includes a seeded
  mismatch so the check is proven to fire.
- [x] **2.2 Fail, do not skip,** when `bash` or `python` is missing, so a Windows run cannot silently drop
  the deploy shell tests.
- [ ] **2.3 Portability lint**: ban Windows-only constructs in `scripts/` and `tests/` (`-WindowStyle`,
  `.cmd`/`.exe` shims, drive letters, `$env:LOCALAPPDATA` without a fallback).
- [ ] **2.4 Smoke-run every workflow script** with the workflow's exact arguments against the fake `gh`,
  starting with the seven that are never executed before production.
- [ ] **2.5 Linux receipt before merge.** `ship-loop -Action Validate` writes a receipt bound to the head
  SHA; the merge rule in `AGENTS.md` and the promoter evidence gate require it.
- [ ] **2.6 Host contract test**: flags in `integrations/bazzite/*.service` `ExecStart` lines and Python
  `command:` steps are checked against the scripts' argument parsers.
- [ ] **2.7 Scratch-state test**: run the validation and handoff gates in a worktree seeded with tracked
  and untracked `.factory/` content.
- [ ] **2.8 Canaries do not roll back on transient GitHub errors** (rate limit, truncated output):
  inconclusive, retry.
- [ ] **2.9 A candidate with no changed paths is not a failure** and does not count toward the breaker.
- [ ] **2.10 Fixture canary for plan, implement, review** against a sandbox repository, the largest
  remaining blind spot.

## Phase 3: turn it back on and prove it

- [ ] **3.1 Owner decision: re-enable the implement and fix automations** (`ready-to-implement-*`,
  `changes-requested`), one at a time. They were paused on 2026-11-07 for Claude token cost; while they
  are off, nothing in `factory:ready` can move regardless of everything above.
- [ ] **3.2 Order the queue**: stabilization issues ahead of features (backlog priority), so re-enabling
  does not start with a large feature.
- [ ] **3.3 Run one fixture issue end to end** (new, plan, implement, review, merge, promote) with no
  human touch.
- [ ] **3.4 Decide the parked issues that need a person**: #115 (use an in-repo fixture as the non-Godot
  pilot?) and #39 (do the registered targets have validation adapters?).
- [ ] **3.5 Verify-then-close the inferred-delivered issues**: #25, #37, #65, #17.

## Exit criteria

- Seven consecutive days with an empty stall report (no issue past its state deadline).
- Ten consecutive candidates reach `stable` with no rollback and no post-merge Linux-only failure.
- A promoter-filed failure issue is taken in, fixed, and closed without a person.
- A new lifecycle step (the technical-design sign-off) is switched on for one project by editing
  configuration only.

Then the feature backlog reopens.

## Log

- 2026-11-11: plan written from three audits (state machine, validation gaps, issue triage).
- 2026-11-11: triage (0.4, 0.5). Closed as resolved or superseded: issues #427, #378, #372, #364,
  #320, #306, #304, #67, #66, #29, #28, #26, #21, #19, #1, #61; PRs #301, #87, #86, #85, #84, #82, #81,
  #80, #74, #44 (branches kept). Removed stale `factory:auditing` from #133, #132, #131, #93, #72, #71,
  #51, #92, #91, #73; #102 keeps `risk:high` only; #164 is now `factory:tracking`. Left open on purpose:
  #432, #377, #375 (live until 0.7), and the inferred ones in 3.5.
- 2026-11-11: batch 1 (issue #437, PR #438, `e0c68bf`) delivered 0.1, 1.1, 1.2, 1.3, 2.1, 2.2. Windows and Linux
  full suites passed on the merged commit. 0.1 is the code fix only; 0.7 confirms it on the host.
- 2026-11-11: owner direction: the lifecycle must be configurable (added cause 3 and item 1.4a-f).
- Noted for 1.6: `maintain-repository.ps1` and `recover-audit-reservations.ps1` read `CEZAR_API_URL`
  and `CEZAR_PROJECT_ID`; the maintenance workflow only has `CEZ_API_URL` and `CEZ_PROJECT_ID`.
- Noted for 0.2: `[factory] backlog-label-audit` is disabled on the host, so no new root commits are
  expected, but the cause of the earlier ones is not established.
- Residual from #28: `scripts/release/promote-stable.ps1` still accepts `-TestScript`.
- 2026-11-11: batch 2 delivers 1.4a and 1.4b (`policies/lifecycle.json`, `scripts/lifecycle-lib.ps1`, soundness test with
  a design-gated profile) and starts 1.4c with the stale refresher. The model file is JSON with the checker as its
  validator; per-transition `when` conditions are accepted but not yet interpreted by any script (1.4e).
- 2026-11-12: batch 2 merged (issue #439, PR #440, `4bb870a`). Found promotion deadlocked (item 0.8): the host
  promoter read `controlled` from the `stable` checkout, so #436 and everything after it sat `blocked` at the
  approval gate while `health` said `ok`. Owner chose the break-glass path; `promote-stable.ps1` re-ran the
  full suite on `4bb870a` and fast-forwarded `origin/stable` to it at 12:47Z.
- 2026-11-12 12:51Z: host deploy confirmed. Autodeploy advanced the host `de34a4c` to `4bb870a`; the new reconcile
  script preserved the stray commit as `refs/factory/displaced/21bd05f...` and moved the container's stable
  ref; Cezar was rebuilt and restarted healthy; the host policy now reads `autonomous`. Stable pointer, host
  checkout and `origin/stable` agree. The `dev` channel pointer is still `de34a4c` (break-glass skips dev
  activation) until the next candidate passes. `4bb870a` itself is recorded as failed by the promoter (item 0.9),
  so the breaker count is 1. Still open for 0.7: close #432, #377, #375 once a candidate promotes normally.
- 2026-11-12: batch 3 (issue #442) delivers 0.3.
- 2026-11-12 13:18Z: first normal promotion since the deadlock. Batch 3 (PR #444, `450faf8`) passed the evidence gate
  on its self-review, validated, activated `dev` and was promoted to `origin/stable` by the promoter in eight minutes
  with no manual step. At 13:19Z the last stage was still in progress: the stable pointer read `4bb870a` and
  `health` (now running the new code on the host) correctly said `stalled` for the 13.8h drift. Next session:
  confirm the stable pointer reached `450faf8` and health returned to `ok`, then finish 0.7 (close #432, #377,
  #375; the breaker count is 1 from item 0.9 and resets on a successful stable deploy).
- Next up, in order: 0.9, 0.2, 1.4c (remaining scripts), 1.5, 2.4, 2.5.
- 2026-11-12 13:25Z: confirmed. `450faf8` is `healthy` at stage `stable-deployed`; drift has no findings; `health` is
  `ok`; the breaker count reset to 0 without a manual `reset-breaker`. Closed #432, #377 and #375 (item 0.7 done).
