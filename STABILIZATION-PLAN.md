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
- [x] **0.2 Find what committed on the root `stable` checkout** (also the cause of #427 and PR #301) and
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

- [x] **0.8 The delivery path cannot repair itself.** The promoter and the deployer run from the host
  checkout on `stable`, so a fix to the gate policy, the promoter, or a deploy script has to pass through
  the very thing it fixes. On 2026-11-12 this deadlocked twice at once: the `autonomous` policy (#436) was
  blocked by the `controlled` policy still on the host, and the reconcile fix (#438) could not deploy
  because the old reconcile script ran first. It was cleared by hand with `promote-stable.ps1`. Needed: a
  blocked or failing delivery path escalates within the hour instead of waiting silently, and a documented,
  tested recovery for each stage (gate, validation, stable ref, host deploy) that does not depend on the
  stage that is broken.

- [x] **0.9 A deploy restart kills a validation in progress.** The promoter runs the full suite inside the
  Cezar container with `podman exec`; autodeploy waits only for Cezar runs to be idle before it restarts the
  container, so a restart during validation kills the suite (exit 137), and the failure is cached for that
  SHA and counts toward the breaker. Seen on `4bb870a` at 12:55Z on 2026-11-12. The two timers need one
  lock, or the deployer must treat a running validation as busy, and a killed check must be retried, not
  cached.

- [x] **0.10 Find what exhausts the GitHub API budget (answered: bursts of interactive and agent use).** The account's GraphQL budget was fully spent in one hour on
  2026-11-12 (and `last_issue_error` showed rate limits earlier). When it is spent, every automation, the promoter's
  evidence gate and issue filing all fail together. Measure calls per component per hour on the host and cut the
  largest; the sweep, refresher and delivery sync already share one cached listing.

- [ ] **0.11 Containers start before the host has its address.** At boot on 2026-11-12 Podman's rootless network
  namespace was created while the host only had a link-local address, so `host.containers.internal` was dead for
  every bridge-network container (Cezar, Postiz, Langfuse, Obot, Hindsight) until all of them were stopped and
  started again by hand. Needs the owner on the host: make the user session wait for a real address before
  `podman-restart.service` and `container-cezar.service` run (for example enable `NetworkManager-wait-online`,
  or order both after a unit that waits for a non-link-local address). The compose monitoring stack also starts
  at boot now; decide whether it should.

- [ ] **0.12 The maintenance run, and so the promotion canary, depends on the Claude 5-hour limit.** The 20:00Z and
  21:00Z maintenance runs failed at the `backlog-label-audit` agent step with "You've hit your 5-hour limit, resets
  11pm (UTC)". The agent steps are routed to `claude`/`sonnet` (temporary routing from 2026-11-07), so any hour in
  which that limit is spent fails the whole run, and the promoter's `maintenance` canary uses the same automation, so
  a candidate can be rolled back for a reason that has nothing to do with it. If the host's Claude login is the same
  account as an interactive Claude Code session, that session spends the same limit. A step cannot be marked
  allowed-to-fail in this Cezar version (`onFail` only retries). Options for the owner: route housekeeping agents back
  to the local model once the codex no-op is fixed; retire the label-audit agent, since the lifecycle sweep and intake
  now cover what it did; or give the canary a deterministic maintenance workflow with no agent step.

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
- [x] **1.5 One invariant sweep in `factory-maintenance`** driven by that model. Repairs what is
  mechanical (two state labels, no state label, `ready` without exactly one complexity label, `blocked`
  whose blockers all closed, `pr-open` whose PR closed unmerged) and lists everything past its deadline in
  one rolling "Factory stall report" issue. Replaces the per-slice sweeps over time.
- [x] **1.6 Crash recovery for `factory:working`.** Verify and fix the `CEZAR_API_URL` versus
  `CEZ_API_URL` mismatch that makes "latest run failed" detection fall back to a 24-hour wait; stop
  comments from resetting the clock (use time in state).
- [x] **1.7 Watchdog covers issue-scoped runs** (plan, implement, review, fix, investigate), not only the
  four housekeeping workflows.
- [x] **1.8 `needs-help` requires a real question.** An escalation without a structured decision returns
  to `factory:needs-plan`; open decisions get a weekly digest instead of silence.
- [x] **1.9 PR sweep.** A `CONFLICTING` PR into `dev` routes its issue to `factory:changes-requested`;
  drafts and PRs without a closing keyword are reported.
- [x] **1.10 Bound the investigate, re-plan, implement loop** (today only the direct retry is capped).
- [ ] **1.11 Re-enabling an automation reconciles existing labels** instead of baselining to "now"
  (make every automation level-triggered, as intake already is with `fullReconcileHours`).
- [x] **1.12 Correct `docs/lifecycle.md`** where it disagrees with `route-state.ps1` (`blocked` is never
  set by the router; `human-review` has no writer).
- [x] **1.13 Deploy and use the stall detector from #434** (`/api/v1/dependency-graph/stalls` returns 404
  on the host until `stable` moves); teach it complexity labels and script-side gates.

## Phase 2: breakage is caught before merge

- [x] **2.1 Static contract test** in `tests/run-tests.ps1`: every `.ps1` parses (recursive, errors
  fail), every `.py` compiles, every `.sh` passes `bash -n`, and every workflow `command:` step names an
  existing script and passes only declared parameters, including all mandatory ones. Includes a seeded
  mismatch so the check is proven to fire.
- [x] **2.2 Fail, do not skip,** when `bash` or `python` is missing, so a Windows run cannot silently drop
  the deploy shell tests.
- [x] **2.3 Portability lint**: ban Windows-only constructs in `scripts/` and `tests/` (`-WindowStyle`,
  `.cmd`/`.exe` shims, drive letters, `$env:LOCALAPPDATA` without a fallback).
- [ ] **2.4 Smoke-run every workflow script** with the workflow's exact arguments against the fake `gh`,
  starting with the seven that are never executed before production.
- [x] **2.5 Linux receipt before merge.** `ship-loop -Action Validate` writes a receipt bound to the head
  SHA; the merge rule in `AGENTS.md` and the promoter evidence gate require it.
- [x] **2.6 Host contract test**: flags in `integrations/bazzite/*.service` `ExecStart` lines and Python
  `command:` steps are checked against the scripts' argument parsers.
- [ ] **2.7 Scratch-state test**: run the validation and handoff gates in a worktree seeded with tracked
  and untracked `.factory/` content.
- [x] **2.8 Canaries do not roll back on transient GitHub errors** (rate limit, truncated output):
  inconclusive, retry.
- [x] **2.9 A candidate with no changed paths is not a failure** and does not count toward the breaker.
- [ ] **2.10 Fixture canary for plan, implement, review** against a sandbox repository, the largest
  remaining blind spot.

- [ ] **2.11 A canary runs the new scripts with the old workflow definition.** The maintenance canary for `941134a`
  ran scripts from the candidate's runtime (`factory-runtime/941134a`) but its step list was the one on `stable`:
  it had no `lifecycle-sweep` step. A change to a workflow file is therefore never canaried, and a script whose
  parameters change is canaried against the old command line. Make a canary run the candidate's own workflow
  definitions, or record it as a known limit and rely on the workflow contract test.

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
- [x] **3.5 Verify-then-close the inferred-delivered issues**: #25, #37, #65, #17.

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
- 2026-11-12: batch 4 delivers 0.8, 0.9, 2.8 and 2.9 in the promoter and the deploy script, with a recovery table in
  `docs/promotion-pipeline.md`.
- 2026-11-12 ~13:50Z: the Bazzite host stopped answering ping, SSH and the Cezar API (the gateway and the Mac mini
  answer). It was healthy at 13:25Z. Cause unknown; needs the owner at the machine. Until it is back there is no
  Linux validation and no promotion. PR #446 (batch 4, promoter changes) is held unmerged for that reason.
- 2026-11-12: batch 5 delivers 1.5, 1.6, 1.9 and 1.12 and moves three more scripts to the lifecycle policy (1.4c
  still open for `route-state.ps1`, intake selection and the label scripts; a ratchet test stops the list growing).
  1.6 note: "time in state" still uses last activity, because the issue listing has no label timeline.
- 2026-11-12 14:19Z: the host is back after a reboot (cause of the outage still unknown; the compose monitoring stack
  also started at boot). At 14:22Z a `gh` call from the dev machine failed with "GraphQL: API rate limit already
  exceeded": the shared 5,000-point hourly budget had been used up in the window 13:21Z to 14:21Z. The consumer is not
  identified (new item below).
- 2026-11-12: batch 4 merged (PR #446, `3bbf40f`) and batch 5 merged (PR #448, `ae948a3`), both after Windows and
  Linux full-suite runs.
- 2026-11-12: batch 6 delivers 2.3, 2.5 and 2.6 and starts 2.4: six of the seven never-executed scripts are started
  as their workflow starts them (`collect-environment-state.ps1` is left out because it probes real endpoints).
  2.4 stays open for running every workflow script against fixtures to a structured result. 2.5 is enforced by
  the `AGENTS.md` rule and the receipt; the promoter validates on Linux itself, so its gate is unchanged.
- 2026-11-12 18:00Z: promotion was failing again. Since the 14:19Z reboot the Cezar container could not reach
  LiteLLM through `host.containers.internal` (item 0.11), so batches 4 and 5 were validated, activated, failed the
  `maintenance` canary's model check and were rolled back and quarantined (2 of 3 failures toward the breaker).
  With the owner's approval all 26 containers on the Podman bridge networks were stopped and started again at
  19:07Z; the snapshot is in `~/.local/share/cezar-factory/rollback/netns-rebuild-20261112T190646Z.txt` on the
  host. The model probe passes from inside Cezar again.
- 2026-11-12: batch 6 merged (PR #451, `941134a`). Batch 7 delivers the environment preflight and 1.7, 1.8, 1.10.
  1.8's digest is the stall report: a `factory:needs-help` issue idle for a week is listed there.
- 2026-11-12 19:20Z: batch 6 (`941134a`) passed the model check but its `maintenance` canary failed and the breaker
  opened. Cause: GitHub answered HTTP 502 while `create-labels.ps1` re-created a label; the canary's reason only said
  "exited non-zero", so the transient retry from batch 4 had nothing to match. Batch 7 adds the step output to the
  reason and makes label creation write only what differs. Also found: item 2.11.
- 2026-11-12: batch 7 merged (PR #455, `5536a9b`) after Windows and Linux full-suite runs.
- 2026-11-12: 0.2 answered from history, and corrected the same day. There were two sources of commits. (1) The
  label-audit agent step committed, pushed a `cez/<id>` branch and sometimes opened a pull request to `main`
  (#380 and #419 were merged there; #301 was closed in the triage), with an improvised message each hour. That
  stopped when #425 untracked its scratch file. (2) Cezar's end-of-run autosave ("cezar autosave (run finalize)",
  author "Factory Investigator") commits whatever scratch is not ignored, after the last workflow step. It is still
  happening: each maintenance run on the host ends with one such commit (`.factory/gh-cache/*.json` and
  `.factory/release-reports/shadow-audit.json`), and my batch 5 added two more unignored files
  (`lifecycle-sweep.json`, `run-commits.json`) that would have joined them. Batch 8 inverts the ignore rule so
  everything under `.factory/` is ignored unless deliberately tracked, with a suite test. How one reached the root
  `stable` ref is still not established; the reconcile step handles it. Left for the owner: the host's container has
  1,741 local `cez/*` branches and 13 worktrees (507 MB of worktrees, disk at 97%), `origin` has 132 `cez/*` branches
  of which 126 carry such commits, and `main` has 3 bot commits that `dev` lacks.
- 2026-11-12 20:35Z: batch 7 (`5536a9b`) cleared the evidence gate and the environment preflight, then failed at activation on
  `gh repo view` (a transient GitHub error; the command works now). Batch 8 retries a transient activation error on the next
  tick instead of failing the candidate. The next merge is promoted as a new candidate regardless.
- 2026-11-12 21:40Z: 3.5 done. Verified against the code and closed with evidence: #25, #65 (delivered), #37
  (superseded by the sweep, the refresher and intake reconciliation), and their tracking parents #20 and #17.
- 2026-11-12 21:40Z: 1.13 done in part. The stall detector from #434 is live on the host
  (`/api/v1/p/cezar-factory/dependency-graph/stalls`, revision 2,062). Its verdict before the closes above: 8 issues can
  progress and 59 are stuck, of which 43 are `no-consumer` (the `factory:ready` work whose implement automations are
  disabled, item 3.1), 12 `stale-blocked-label` (the sweep unblocks these gradually), 4 `no-state-label` (the sweep
  repairs these) and 4 waiting on a person. Teaching it complexity labels and script-side gates moves to 1.4f.
- 2026-11-12 21:40Z: 0.10 measured. One dependency-graph page query costs 3 GraphQL points (measured with
  `rateLimit { cost }`), so that sync is not the consumer. Usage reads about 850 to 2,300 points inside the same
  quarter hour, with two different reset times (21:41Z and 22:25Z) and a counter that went down between samples, so
  more than one credential or bucket is sharing this account; the container and this machine report the same
  figure. Attribution needs the consumers instrumented (calls per component per hour). `ship-loop -Action Health` now
  prints the remaining budget and warns below 500, so an exhausted budget is no longer mistaken for a release defect.
- 2026-11-12 21:45Z: 0.10 answered. Sampled once a minute with no other `gh` activity from the dev session: GraphQL usage
  read 856, 856, 858, 859, 861, about 75 points an hour, so the Factory's own automation (graph sync, pollers, promoter,
  maintenance) is a negligible consumer. The two exhaustion events followed bursts of `gh pr`/`gh issue` calls and three
  parallel audit agents from the interactive session, which share the account's 5,000-point hourly budget. The odd readings
  (2,322 once, a second reset time) were not reproduced and are left unexplained. Practical rule: bulk issue and PR edits go
  through the REST API (`gh api`), which has its own budget; `ship-loop -Action Health` shows what is left.
- 2026-11-12 22:00Z: first scheduled maintenance run on the new code (`306ac6e1`, 51 seconds, all 20 steps done),
  with `watchdog-issue-runs`, `lifecycle-sweep` and `no-run-commits` live. The sweep created the "Factory stall report"
  (#460) with eight findings and made no repair: #228 (working for 71 h, a person's), #129 (its blocker is closed but
  it is a person's and waits on the disk), #116, #107 and #105 (blocked, no blocker named), #89 and #70 (waiting on a
  person past a week) and #39 (blocked 27 days). #107, #105 and #116 were verified (every issue they name is closed)
  and returned to `factory:ready`. The remaining items need the owner: #228, #129, #89, #70, #39.
- 2026-11-12 21:50Z: batch 8 (`d0fcee9`) went to `stable-deployed` through the promoter with no manual step; the host
  checkout, the policy with its preflight, the scratch-ignore rule and the sweep step are all on the host; health `ok`.
  This is the first end-to-end proof that a fix to the delivery path reaches the host unaided.
