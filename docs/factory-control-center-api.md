# Factory Control Center local API

`scripts/release/factory_control_center.py` exposes a loopback-only, versioned
HTTP API over the existing release controller store. It is a projection and a
thin action dispatcher: reads never parse deployment logs, and action requests
call the existing `ReleaseController` methods under the same `controller.lock`
used by the CLI and release services. It does not activate automations, change
project registries, promote a channel, or deploy a target.

## Start the local API

Copy `config/control-center-access.json.example` to a private host-local file.
Create a random token and store only its lowercase SHA-256 digest in that file:

```python
import hashlib, secrets
token = secrets.token_urlsafe(32)
print(token)
print(hashlib.sha256(token.encode()).hexdigest())
```

Assign `viewer` for reads, `operator` for sync/stage/verify/protect/unprotect,
and `release-admin` for all operations including rollback. Keep the token file
private. Then start the API in a foreground terminal on the host:

```bash
python3 scripts/release/factory_control_center.py serve \
  --repo ~/cezar-factory \
  --store ~/.local/share/cezar-factory/release-store \
  --scheduler-store ~/.local/share/cezar-factory \
  --registry ~/cezar-factory/config/factory-projects.json \
  --token-file ~/.config/cezar-factory/control-center-access.json
```

The default bind is `127.0.0.1:8765`. The server rejects non-loopback bind
addresses. Requests require `Authorization: Bearer <token>`. The token itself
is never stored in the audit log or returned by the API. The service uses no
new authentication provider; its local token file maps credentials to fixed
roles. Shut down the foreground process with Ctrl+C.

## Endpoints

All endpoints are under `/api/v1` and return JSON. Unknown or invalid input
returns `schemas/control-center/error.schema.json` with a stable error code.

| Method and path | Scope | Purpose |
| --- | --- | --- |
| `GET /control-center` | `read` | Aggregate snapshot, with source availability and freshness. |
| `GET /releases?channel=dev&state=verified&limit=25&cursor=…` | `read` | Stable, bounded release pagination. `limit` is 1–100. |
| `GET /events?cursor=0&limit=50&waitSeconds=10` | `read` | Poll or long-poll newer audit and observed read-model change events. `waitSeconds` is 0–20. |
| `GET /actions/{idempotencyKey}` | `read` | Retrieve the original action receipt. |
| `POST /actions` | Action-specific role | Submit one controller action. |

Example action body:

```json
{
  "schemaVersion": "factory-control-center-action/v1",
  "idempotencyKey": "operator-request-20261122-0001",
  "action": "stage",
  "channel": "dev",
  "sha": "0123456789abcdef0123456789abcdef01234567",
  "reason": "Stage the reviewed development candidate"
}
```

`sync` and `stage` may omit `sha` to follow the configured channel ref;
`stage` with a SHA stages that exact commit. `rollback`, `verify`, `protect` and
`unprotect` require a full SHA. Protection actions also require `referenceKind`
and `referenceId`; `expiresAt` is optional for `protect`. Reusing a key with the
same request returns the stored receipt. Reusing it for a different request
returns `idempotency_conflict`. If a process exits after recording an action
start but before the completion receipt, a retry is fenced and reported as
`interrupted`; the API will not run the controller operation twice.

## Read-model behavior

The aggregate joins explicitly configured project IDs with activation receipts,
and joins release manifests/state with controller and scheduler records. It
reports desired, actual and observed SHAs independently. Freshness is computed
from structured observation times; absent data is `unknown`, and old data is
`stale`. A mismatched or missing channel pointer does not become healthy.

If the release store becomes unavailable, the last complete response is served
from the separate cache file with `source.status: offline`, stale freshness and
unknown health. Without a cached response, the API returns an empty offline
snapshot. Worker CPU and memory values stay null unless a validated
`factory-worker-resources/v1` snapshot is supplied with `--worker-snapshot`.
The scheduler's single-flight slot count remains a separate partial observation.

The change feed uses an increasing integer cursor. Action audit events are
append-only. A poll also compares the current structured read-model digest and
records a compact `read-model-changed` event when it differs from the prior
observation. Asking for a cursor never returns an event at or before it.

## Validation

The API contracts and behavior are covered by `tests/test_factory_control_center.py`.
The local Factory suite includes the tests; no GitHub Actions or production
service installation is part of validation.
