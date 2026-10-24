# Host-local Factory release controller

The Bazzite user service polls one explicitly configured Git branch, stages its
commit as an immutable archive, verifies the manifest, artifact, archive paths,
file digests and verification evidence, then atomically writes the channel
pointer. It never runs prompts or project code, calls Cezar, resets a checkout,
or writes to the source working tree. `stable` remains the default channel and
must be advanced through the tested stable promotion procedure.

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

Install the service and timer under the account that owns the Factory checkout:

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
