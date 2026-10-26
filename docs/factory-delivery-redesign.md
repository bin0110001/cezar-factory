# Factory delivery redesign: self-healing releases

> Historical proposal. Current release behavior is governed by AGENTS.md,
> docs/shared-factory.md, skills/factory-release, and
> skills/factory-finish-release. Do not apply the channel or recovery proposals
> below without reconciling them with those current instructions.

Status: proposed. Audience: Factory contributors.

Goal: Factory changes (scripts, skills, workflows, policies, templates,
automations) reach every project without manual intervention on projects set to
the `dev` channel, and after a reviewed promotion on projects set to the
`stable` channel. Pipeline failures are detected, repaired and shipped by the
Factory itself. Humans are the last resort, not the default.

## 1. How delivery works today

There are two overlapping mechanisms with different notions of "current".

**Path A: shared mount (v0.3.42+, `docs/shared-factory.md`).**

1. A change is merged to `dev`.
2. A human runs `scripts/release/promote-stable.ps1`. It runs the tests and
   fast-forwards `origin/stable`.
3. A Bazzite systemd timer runs `scripts/deploy/factory-autodeploy.sh` every
   five minutes. It fast-forwards the mounted checkout to `stable`, compares
   `VERSION` inside the container, and re-syncs automations.
4. Cezar reads workflows and skills from the mount through
   `CEZ_SHARED_WORKFLOWS_DIRS` / `CEZ_SHARED_SKILL_DIRS`. Scripts run from
   `$FACTORY_RUNTIME_ROOT`.

**Path B: legacy per-project push (`scripts/push-factory-updates.ps1`).**

- Pins `factory.version` in each project and copies managed files into `.ai/`.
- For remote targets, syncs automations over the Cezar API, then runs an SSH
  preflight on the Bazzite checkout (clean tree, `VERSION` equal to the
  Windows checkout, no pull or reset).

`AGENTS.md` and the `factory-release` skill still describe both paths.

## 2. Problems found

Ordered by how likely they are to explain stale projects.

1. **`stable` lags `dev`.** At the time of analysis `origin/stable` was at
   `418585a` (version 0.3.44, promoted 2026-10-11) while `origin/dev` was 49
   commits ahead at 0.3.50. Promotion is a manual step that nothing forces, so
   merging to `dev` changes nothing for projects.
2. **Two definitions of "current".** Path A follows `stable`. Path B requires
   the Bazzite `VERSION` to equal whatever checkout the operator ran from, often
   a `dev` or `codex/*` branch. Running Path B from the wrong ref either blocks
   (exit 21) or deploys something the timer will not.
3. **Success is reported at the wrong layer.** `RELEASE_STATUS synchronized`
   means Cezar's API accepted automation JSON. It does not say whether the
   workflows, skills and scripts at the mount are current. Automations can be
   new while the workflows they invoke are old.
4. **The autodeploy refuses instead of recovering.** A dirty tree (exit 20), a
   diverged tree (21) or a container/host version mismatch (22) stops the run
   with a log line only. Nothing recovers it or surfaces it.
5. **Migration is incomplete and shadowing is invisible.** A project's own
   `.ai/cezar/workflows/factory-*.yaml` or `.ai/skills/*` wins over the shared
   copy by name, so an old installed copy silently overrides the new shared
   one. No registry entry sets `"mode": "shared"`, and environment analysis does
   not report shadowing.
6. **Task worktree staleness (separate mechanism).** `git-worktree.ts` fetches
   `origin/<base>` before forking, but the fetch is best-effort. If it fails, a
   task can fork from a stale base.
7. **Smaller defects.**
   - The `factory-release` skill's promote command has a path typo
     (`.\scriptselease\promote-stable.ps1`; the `\r` of `\release` was eaten).
   - Releases are triggered by agents following skill prose.
   - `cezar-factory`'s own `fullFactoryProjectPath` is
     `not-configured-on-windows`.

Not verified from the repo: the current Bazzite checkout SHA, the autodeploy
timer's journal, and whether the projects still carry installed Factory copies.
Step 0 below checks these.

## 3. Target design

### 3.1 Channels

Each project in `config/factory-projects.json` gets
`"channel": "dev" | "stable"`.

- `dev`: runs the tested head of `dev` automatically. No human involved.
- `stable`: runs `stable`, which only moves after a reviewed `dev` to `stable`
  PR.

### 3.2 Immutable releases instead of a mutable checkout

- The deploy builds `releases/<sha>` as a clean export of the commit.
- Per-channel `current-dev` and `current-stable` symlinks are swapped
  atomically.
- Cezar mounts the releases directory once. `FACTORY_RUNTIME_ROOT` for a task
  resolves from the project's channel. No container restart on deploy.
- Dirty, diverged and "not an ancestor" checkouts (exits 20 and 21) cannot
  occur. Hand edits on the host are discarded.

### 3.3 Per-project resolution in Cezar

Today `CEZ_SHARED_WORKFLOWS_DIRS`, `CEZ_SHARED_SKILL_DIRS` and
`FACTORY_RUNTIME_ROOT` are global. They must resolve per project from its
channel, and each run must record the Factory SHA it used. Touches
`cezar/packages/cezar/src/shared-dirs.ts` and the workflow loader.

## 4. Release pipeline

1. **Merge to `dev`**: reviewed PR with auto-merge, as `AGENTS.md` requires.
2. **CI promotes `dev` automatically.** On merge, CI runs the full suite and
   advances a `dev-tested` ref. This replaces manual `promote-stable.ps1`.
3. **Deploy to dev-channel projects.** The host timer fetches `dev-tested`,
   builds the release, runs a smoke workflow in the `cezar-factory` project,
   then swaps `current-dev`.
4. **Automatic rollback.** If the smoke test fails, `current-dev` stays on the
   last known good release and the bad SHA is quarantined. This is a state
   change, not an issue. A fix is queued (section 5).
5. **Stable promotion.** A bot opens a `dev-tested` to `stable` PR once a
   release has soaked cleanly (default 24 hours with no failures). The existing
   independent-review gate applies, and auto-merge follows approval. Only
   `stable`-channel projects wait on this.

Every deploy writes `deployed.json` (channel, SHA, time, health) so Cezar and
the audit automations can read what is actually running.

## 5. Self-healing loop

- **Detect.** The existing watchdog, failure-audit and environment-analysis
  automations compare each run's recorded Factory SHA to its channel head, and
  also check the deploy record, automation sync state and shadow copies.
- **Fingerprint and classify.** Each failure gets a signature that dedupes
  repeats.
- **Resolve, in order.**
  1. Known class: a deterministic repair run as a workflow `command:` step
     (re-run the deploy, remove a shadow copy, refetch the base, re-sync
     automations).
  2. Unknown class: a `factory-fix` workflow writes a fix PR to `dev`, which
     then flows through section 4.
  3. Only a failure that survives repair and fix attempts is escalated.
- **Escalate quietly.** Escalations go into one rolling status issue with a
  cap (one open at a time), not one `needs-help` issue per failure.
- **Guardrail.** Automatic fixes may not touch the deploy and promotion
  machinery (`factory-autodeploy.sh`, `promote-stable.ps1`, the channel
  resolver) without review, so the loop cannot brick itself. This is the one
  human gate kept even on `dev`.

All scripts in this loop follow the existing rule: they run from `command:`
steps in `workflows/*.yaml`, never from skill or prompt instructions.

## 6. Specific fixes folded in

- **Shadow copies.** The reconcile step detects installed `.ai/factory`,
  `factory-*` workflows and skills in any project and removes them by opening an
  auto-merge PR in `dev`-channel projects (`migrate-to-shared.ps1`, made
  automatic).
- **Stale task worktrees.** A failed pre-fork fetch in `git-worktree.ts`
  retries, then fails the task into the retry path instead of forking from a
  stale base.
- **Legacy push.** Retire `push-factory-updates.ps1` for shared projects.
  Automation sync becomes a deploy step.
- **Docs and skills.** Rewrite `AGENTS.md` and `factory-release` around one
  path. Fix the `\scriptselease` typo.

## 7. Order of work

Each step is a normal reviewed PR to `dev`. Steps 1 and 2 touch the machinery
the rest depends on, so they get the most care.

0. **Read-only SSH checks.** Compare the Bazzite SHA with `origin/stable`, read
   the autodeploy timer journal for BLOCKED exits, and look for installed
   `.ai/factory` or `factory-*` copies in the three projects. Confirms the
   diagnosis before building.
1. **Immutable releases and deploy record**: releases directory, atomic swap,
   smoke test, auto-rollback, `deployed.json`.
2. **Per-project channels in Cezar**: resolver, run recording, registry schema.
3. **CI auto-promotion** to `dev-tested`, and the soak-gated stable PR.
4. **Reconcile and repair runbook workflows**, plus dedupe and the escalation
   cap.
5. **Cleanup**: migrate the three targets, retire the legacy push, rewrite
   docs and skills.

## 8. Defaults (change if wrong)

- All three current projects start on `dev`; any can be switched to `stable`.
- Soak period is 24 hours before a stable PR opens.
- One rolling status issue open at a time.
- The stable channel requires PR approval, not an extra human plan-approval
  gate (the same gate high-risk work already has).
