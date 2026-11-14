# Project channels, drift and migration

`scripts/release/factory_project_channels.py` is the backend read model the Control Center uses for
per-project channel state. It is read-only except for one append-only audit record, reuses the release store,
activation receipts and each project's release diagnostic, and never edits a channel pointer or symlink.

```bash
python3 scripts/release/factory_project_channels.py overview --store <store> --registry config/factory-projects.json
python3 scripts/release/factory_project_channels.py detail  --project <id>
python3 scripts/release/factory_project_channels.py preview --project <id> --channel dev --actor alice --permit alice
python3 scripts/release/factory_project_channels.py request --project <id> --channel dev --actor alice --permit alice --token <preview token>
```

## States are distinct

| Field | Meaning |
|---|---|
| `configuredChannel` / `configuredSha` | The channel the project reports and the SHA that channel's pointer holds |
| `effectiveSha` | The SHA the project actually serves (its diagnostic) |
| `lastSuccessfulActivation` | The last receipt in state `healthy`/`active`; configured is not deployed |
| `deployed` | True only when the last successful activation equals the effective SHA |
| `shadowDiff` | Expected versus observed SHA when they differ |

`installedPrecedence` and `lastReconcile` are passed through from the resolver's diagnostic, never recomputed.
When Cezar is unreachable the record is `stale: true` with finding `unreachable`; host-side facts still show.
Each finding (`shadow_drift`, `failed`, `incompatible`, `unreachable`, `unconfigured`) carries a remediation.

## Changing a channel

`preview` is read-only. It checks the actor against `--permit`, refuses a missing or quarantined target release,
lists active tasks (they stay pinned; only new tasks resolve the new channel; an unreadable task list is a
warning), and diffs modified project overrides against the target release: `unmodified`, `preserved`,
`override-only`, or `conflict` (the release changed a file the project modified). `request` records an audit entry
under `channel-change-audit/` bound to the preview `token`; it is refused with `stale-preview` if tasks, overrides
or the target changed since, and with `permission-denied` for an unlisted actor. The change itself is applied by the
existing promotion/activation flow; this module does not apply it.

The diagnostic fields `activeTasks`, `overrides` (`path`, `digest`, `baseDigest`), `precedence` and `lastReconcile`
are optional; absent ones are reported as unknown. Tests: `tests/test_factory_project_channels.py`.
