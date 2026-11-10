# Host-local Factory release controller

## Host-local diagnosis and repair PRs

`factory-release-self-healing` reads the configured SQLite incident ledger in
read-only mode, emits a deterministic report capped at 50 incidents and 24,000
characters, and updates one issue comment per escalated fingerprint. Its state
receipt is kept at the configured host-local path. If `gh` or network access is
unavailable, the receipt becomes `pending`; the next run retries and searches
for the hidden fingerprint marker before creating a comment. The workflow uses
only the ledger and local `gh`, so it remains usable while Cezar is offline.

Configure `FACTORY_INCIDENT_LEDGER`, `FACTORY_INCIDENT_REPOSITORY`,
`FACTORY_ESCALATION_ISSUE`, and `FACTORY_ESCALATION_STATE` in the host service
environment. Diagnosis includes class, fingerprint, bounded summary, attempt
count, and allowlisted evidence pointers; it never initializes or mutates the
ledger.

`factory-release-fix-pr` accepts only committed changes on a non-protected task
branch, requires an issue-closing body, and opens a PR with base `dev`. It has no
merge operation. It verifies the local validation receipt passed on the exact
clean `HEAD`. Configure `FACTORY_FIX_REPOSITORY_PATH`,
`FACTORY_FIX_REPOSITORY`, `FACTORY_FIX_TITLE`, `FACTORY_FIX_BODY_FILE`, and
`FACTORY_FIX_VALIDATION_RECEIPT` for a prepared local fix. The normal review gate
remains required.
For PRs touching `scripts/release/`, the merge eligibility check requires an
independent current-head approval, or in solo-maintainer mode a structured PR
self-review with scope, risk, invariants, validation evidence, and no unresolved
findings. A nonempty review finding blocks eligibility.

The Bazzite user service polls one explicitly configured Git branch, stages its
commit as an immutable archive, verifies the manifest, artifact, archive paths,
file digests and verification evidence, then runs the recoverable activation
coordinator. `stable` remains the default channel and must be advanced through
the tested stable promotion procedure. The coordinator uses only targets in
`config/factory-projects.json`; it does not discover projects or mutate the
host's Cezar checkout.

Before moving the pointer, activation snapshots each registered project's
Factory automation definitions and enabled state. It swaps the channel pointer,
reconciles desired definitions, and checks Cezar's release diagnostic, workflow
discovery, and automation readback. Each project receives a JSON receipt under
`receipts/`. A failed check restores the saved automation state and pointer,
records a failed or rolled back receipt, and quarantines the candidate SHA.
Incomplete journals are compensated before a later activation can start. A
quarantined artifact must pass explicit `revalidate` before retrying.

The configured registry must exist on the Bazzite checkout and contain explicit
API URLs and project IDs. A missing registry or unavailable target stops
activation before the channel pointer moves. This host-local configuration is
not committed to the Factory repository.

## Drift detection and repair

The controller's `detect` command is read-only. It verifies the local channel
pointer and immutable release, compares the pointer with its SQLite checkpoint,
checks the configured projects' release diagnostics and Factory automation
definitions, and reports the latest failed bounded refetch. It loads targets
only from the explicitly supplied registry (default:
`config/factory-projects.json`); it does not scan for projects. A project serving
a different SHA is reported as shadow drift. Read failures are reported as
infrastructure or compatibility findings.

`repair` defaults to a dry run. Applying it requires `--apply` and takes the
same exclusive controller lock as sync and activation. Repairs are deliberately
limited to reconciling the SQLite checkpoint from a verified on-disk pointer,
retrying a failed refetch by staging the configured ref, and reconciling a
listed project's Factory automation definitions to the verified channel
release. It never switches the channel pointer or redeploys a SHA, and refuses
automation repair for a quarantined release. Shadow/runtime, compatibility,
unreadable-store and infrastructure findings remain open for their owning
recovery path rather than being guessed at.

Each applied attempt is admitted through `incidents.sqlite3`, which enforces
the failure-class budget and backoff, and writes a repair receipt. The original
probe runs again after an applied repair; a receipt says `fixed` only if that
probe has cleared, otherwise it remains `open`. Repeating a successful repair
is a no-op. Example commands on the host:

```bash
python3 ~/cezar-factory/scripts/release/factory_release_controller.py detect \
  --repo ~/cezar-factory --store ~/.local/share/cezar-factory/release-store \
  --channel stable --registry ~/cezar-factory/config/factory-projects.json
python3 ~/cezar-factory/scripts/release/factory_release_controller.py repair \
  --repo ~/cezar-factory --store ~/.local/share/cezar-factory/release-store \
  --channel stable --registry ~/cezar-factory/config/factory-projects.json
python3 ~/cezar-factory/scripts/release/factory_release_controller.py repair \
  --repo ~/cezar-factory --store ~/.local/share/cezar-factory/release-store \
  --channel stable --registry ~/cezar-factory/config/factory-projects.json --apply
```

Receipts are stored under `repair-receipts/`; incident attempt budgets and
backoff are stored separately from `controller.sqlite3` in `incidents.sqlite3`.

## Local dev promotion scheduler

`factory_local_scheduler.py` is the promoter described in `docs/promotion-pipeline.md`: after
dev activation it also runs canaries, rolls back on failure, and fast-forwards and deploys
`stable`. It polls `origin/dev` and checks that the exact candidate SHA belongs to a merged PR
targeting `dev` that satisfies the policy's review rule (an approved review, or in the autonomous
posture a recorded self-review). It reaches the authenticated `gh` through the policy's
`ghCommand` (`podman exec cezar gh` on the host); it never logs in or starts GitHub Actions. Checks run serially in a detached worktree at that SHA,
with each check selected from the changed paths and every matching required
check enforced. The example config runs the automation catalog validator for
catalog changes and the full release suite for every candidate. Configured
commands receive the candidate SHA and a one-worker, zero-GPU budget. Output is
bounded before it is stored.

The scheduler checkpoints candidates in SQLite and writes immutable
`promotion-records/<sha>-<id>.json` evidence with a SHA-256 digest. A failed
required check is cached for that SHA and cannot stage or activate it; retrying
requires `--retry-failed`. A newer SHA is checked against all changes since the
active dev pointer. An interrupted run is retried after restart. After all
required checks pass, the scheduler stages the exact SHA (without following a
moving ref) and invokes the activation coordinator. Missing or insufficient
review evidence, a missing or malformed validation config, or an unavailable
registered Cezar target stops the run before activation.

For a check with known project debt, config may name a `baselineCommand`, set
`allowExistingFailures`, and supply a stable `failureFingerprintPattern`. The
baseline runs against the active dev SHA in another detached worktree. A failure
is nonblocking only when every candidate fingerprint already appears in the
baseline failure set; a new fingerprint, missing baseline, or unparseable
failure remains blocking. Release-wide checks should not opt into this rule.

The committed `config/promotion-policy.json` is the scheduler configuration (the autonomous
posture; `config/local-release-scheduler.json.example` shows a controlled one). Make sure
`config/factory-projects.json` explicitly lists only the projects that have selected `dev`, then
install the service and timer alongside the stable controller units:

```bash
install -m 0644 ~/cezar-factory/integrations/bazzite/factory-local-promotion.service ~/.config/systemd/user/
install -m 0644 ~/cezar-factory/integrations/bazzite/factory-local-promotion.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now factory-local-promotion.timer
```

The oneshot unit caps CPU at two cores, memory at 8 GiB, and concurrency at one;
automatic checks cannot request GPU slots. Inspect runs with
`journalctl --user -u factory-local-promotion.service` and the promotion
records. Do not enable the timer until the Cezar container's `gh` credential, the policy, and
the explicit dev target registry are ready.

## Store layout

The default user store is `~/.local/share/cezar-factory/release-store`:

- `releases/<full-sha>/artifact.tar` contains the exact archived Git tree.
- `manifest.json`, `verification-evidence.json` and `state.json` are immutable
  and match `schemas/factory-release/`.
- `channels/<branch>.json` is the atomically replaced current pointer. It names
  the current and previous verified release by full SHA and absolute path.
- `controller.sqlite3` is the durable checkpoint and bounded attempt ledger;
  SQLite WAL transactions let startup distinguish completed, failed and
  interrupted runs.
- `controller.lock` prevents overlapping timers and manual syncs.

The controller fetches with a bounded retry schedule, then stages into a
same-filesystem temporary directory. It rejects malformed refs, non-regular
archive entries, duplicate paths, path traversal, mismatched sizes or digests,
unknown state schemas, and non-descendant channel updates. Only after verifying
the exact staged bytes does it atomically rename the release directory and
advance the pointer. A crash between those operations is recovered by verifying
and checkpointing the existing immutable release on the next run.

The embedded verification result is deliberately limited to source artifact
integrity. The source `stable` ref is the separate promotion gate for the full
Factory test suite. This controller does not claim to have run that suite.

## Incident ledger module

`scripts/release/factory_incident_ledger.py` provides a separate, host-local SQLite ledger for
release self-healing work. Callers should place `incidents.sqlite3` under the configured release
store; it must not replace or migrate `controller.sqlite3`, which remains the activation
checkpoint. The module uses additive schema version 1 migrations, WAL, and bounded busy waits.

`IncidentLedger.record_failure()` normalizes commit SHAs, timestamps, paths, labeled IDs, durations,
and secrets before computing a stable SHA-256 fingerprint. It records attempts by failure class,
applies the class budget and exponential retry delay, and escalates after the final allowed
attempt. A release incident is marked as known debt and is not counted as a release failure unless
the recorded causal evidence names the same full candidate SHA and includes a source plus stage,
receipt, or evidence ID. Evidence fields are allowlisted and bounded.

An optional `hindsight_summarizer` callback receives only the fingerprint, class, attempt, and
outcome flags. Callback failures are logged as warnings and cannot change the durable ledger result.
No Hindsight service is required for ledger operation. This module is an API for the later
controller-integration phase; it does not change the release controller or service invocation.

Run its unit tests with `python -B -m unittest discover -s tests -p test_factory_incident_ledger.py -v`.

## Retention and rollback

The controller keeps at least three verified releases per channel and never
collects releases younger than 30 days. Current and previous channel pointers
and explicit active references are protected. `protect` and `unprotect` record
task or review references locally; an optional expiry lets normal retention
reconcile stale leases without contacting Cezar. Unknown or unreadable state
fails closed and leaves artifacts in place. If the database is missing, pointer
recovery is verified from disk and unindexed releases remain untouched until
explicitly reconciled.

Rollback selects a full SHA already present in the verified store. It checks
the manifest, bundle, evidence and every archive entry locally, then atomically
repoints the channel. It does not need Cezar or network access:

```bash
python3 ~/cezar-factory/scripts/release/factory_release_controller.py rollback \
  --repo ~/cezar-factory --store ~/.local/share/cezar-factory/release-store \
  --channel stable --sha <full-sha>
```

## Bazzite user timer

Install the service and timer under the account that owns the Factory checkout.
The service runs `factory_activation.py activate`; the legacy autodeploy entry
point also invokes this coordinator after its clean fast-forward, so it cannot
reconcile automations outside the activation journal:

```bash
mkdir -p ~/.config/systemd/user
install -m 0644 ~/cezar-factory/integrations/bazzite/factory-release-controller.service ~/.config/systemd/user/
install -m 0644 ~/cezar-factory/integrations/bazzite/factory-release-controller.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now factory-release-controller.timer
```

Inspect the most recent result with `systemctl --user status
factory-release-controller.service` and `journalctl --user -u
factory-release-controller.service`. The unit runs as the checkout owner, uses a
private temporary directory, has no privilege escalation, and locks locally.
The release store is mounted read-write into Cezar because it must update the
controller SQLite lease table when runs start and finish; Cezar itself only
uses the release directories for reads. It is mounted at
`/var/lib/cezar-factory/release-store`. To enable channel-pinned reads, set
`FACTORY_RELEASE_STORE_HOST_DIR` to the host store and
`CEZ_FACTORY_RELEASE_STORE=/var/lib/cezar-factory/release-store` in the Bazzite
environment, then restart Cezar. Leave the Cezar variable unset until both
`dev` and `stable` pointers have verified manifests. Existing projects default
to `stable`; `PATCH /api/v1/projects/<id>` can select `dev` for new tasks.

Cezar resolves one full SHA when a task starts, records its channel, SHA and
manifest digest in run provenance, reads workflow and skill content from that
immutable release, and exports its path as `FACTORY_RUNTIME_ROOT` to check
commands and agents. Queued and resumed runs revalidate the recorded SHA rather
than following a moved channel pointer. Active runs protect their release with
the controller's retention reference and release that reference at completion.
