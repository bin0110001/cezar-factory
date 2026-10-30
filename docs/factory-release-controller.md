# Host-local Factory release controller

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

## Local dev promotion scheduler

`factory_local_scheduler.py` polls `origin/dev` and checks that the exact
candidate SHA belongs to a merged PR targeting `dev` with an approved review.
It requires the host's existing authenticated `gh` CLI; it never logs in or
starts GitHub Actions. Checks run serially in a detached worktree at that SHA,
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

Create the host-local scheduler config from
`config/local-release-scheduler.json.example`, review the commands and resource
limits, and make sure `config/factory-projects.json` explicitly lists only the
projects that have selected `dev`. Install the service and timer alongside the
stable controller units:

```bash
cp ~/cezar-factory/config/local-release-scheduler.json.example \
  ~/cezar-factory/config/local-release-scheduler.json
install -m 0644 ~/cezar-factory/integrations/bazzite/factory-local-promotion.service ~/.config/systemd/user/
install -m 0644 ~/cezar-factory/integrations/bazzite/factory-local-promotion.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now factory-local-promotion.timer
```

The oneshot unit caps CPU at two cores, memory at 8 GiB, and concurrency at one;
automatic checks cannot request GPU slots. Inspect runs with
`journalctl --user -u factory-local-promotion.service` and the promotion
records. Do not enable the timer until branch review protection, the local
`gh` credential, scheduler config, and explicit dev target registry are ready.

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
