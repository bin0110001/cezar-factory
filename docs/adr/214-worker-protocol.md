# ADR 214: Worker enrollment, authenticated transport and fenced execution leases

## Status

Accepted for the protocol contract and coordinator core (`scripts/worker/worker_protocol.py`,
`schemas/worker-protocol.schema.json`). Wiring it to Cezar's executor and a network listener is
follow-up work; nothing here changes single-host execution.

## Audit of what exists

Local execution runs through Cezar's existing executors and the Podman-backed job runner
(`scripts/local/run-local-job.ps1`, `scripts/openhands/`). Identity and scheduling already belong to the Cezar
control plane (#50/#112/#113), evidence to the digest-addressed store (#130), tracing to #128. There is no
worker registry that a second host can attach to. This ADR adds none of those again: it defines the protocol
a worker speaks and the authority rules, and reuses Cezar's store and scheduler for persistence and
placement.

## Transport decision

| Option | For | Against |
| --- | --- | --- |
| Worker-initiated outbound HTTPS long-poll/WebSocket with a bearer enrollment token | Works through NAT and firewalls, no inbound port on the worker, no engine socket, same shape locally and remotely | Token handling; needs TLS |
| mTLS | Strong channel identity | Certificate issuance and rotation burden for a solo-maintainer host |
| gRPC | Typed streams | New dependency and a second API surface beside Cezar's HTTP API |
| Coordinator-initiated (SSH/Podman socket) | Simple | Exposes a shell or the container engine; rejected |

Chosen: **worker-initiated outbound HTTPS to Cezar's existing API**, enrollment token per node, TLS required
off-host (mTLS may be layered later without a protocol change). A local worker uses the same logical calls in
process, so no remote service is needed. Protocol versions are negotiated at connect; the highest shared
version wins and no shared version leaves the worker `unsupported`.

## Contract

- **Identity.** A persistent `node_id` plus a one-time enrollment token (only its SHA-256 is stored). Each
  connect issues an ephemeral session id and session key. Rotation and revocation kill the session at once.
- **States.** `registered`, `healthy`, `draining`, `offline`, `quarantined`, `unsupported`, `revoked`.
  Freshness is judged only by the coordinator's clock against `heartbeat_ttl`; a worker's clock is never
  trusted, so skew cannot extend or shorten a lease.
- **Leases.** A claim binds `attempt_id` to a node and session with a monotonic fencing token per attempt
  (never reused, kept across coordinator restarts), an idempotency key (retry returns the same lease), and an
  expiry. A second claim while a lease is live is refused. Reclaim after expiry issues a higher fence.
- **Receipts.** Signed with the session key (HMAC over attempt, fence, nonce, outcome, evidence). A receipt is
  accepted once, only with the current fence, a live lease and a valid signature. Workers may report only
  `passed` or `test_failed`. Evidence is capped at 64 KiB; larger artifacts use the authorized artifact path.
- **Typed outcomes.** `auth_failed`, `unsupported_capability`, `worker_disconnected` (lease expired before
  start), `started_but_lost` (expired after start), `stale_fence`, `rejected_replay`, `cancelled`, `expired`,
  `test_failed`, `passed`. Each is an event on the coordinator.
- **Spool.** The worker keeps a bounded spool of finished results and reports them after reconnect. The
  coordinator decides acceptance; a rejection drops the entry, a transport error keeps it.
- **Commands.** A version-pinned adapter name, adapter version and a bounded list of string arguments. There is
  no shell string, no endpoint that runs one, and capability checks happen before the lease.
- **Coordinator restart.** The snapshot keeps fences and idempotency keys. Live leases restore as lost, sessions
  do not survive, so an old worker's results are refused and a reclaim gets a higher fence.

## Graphical sessions (#328/#329)

A graphical session is attached to an existing lease and inherits its fence: it carries the lease's
`(attempt_id, session_id, fence)` and is valid only while that lease is current. A stale worker session can
therefore never take control, publish evidence or release the session twice. Observation, control and
clipboard/file transfer are separate grants decided by the coordinator; screenshots and control metadata ride
the same channel, bounded; video and large media use the artifact path. No desktop, browser debug port, X11/
Wayland or engine socket is exposed. Runtime details belong to #328/#329 and ADR 337/344; this ADR supplies
only the transport and fencing hook. The session-association implementation is not in this change.

## Threat model

| Threat | Mitigation |
| --- | --- |
| Stolen enrollment token | Scoped to one node, hash-only storage, rotation and revoke invalidate sessions immediately |
| Compromised worker | Can only report `passed`/`test_failed` for leases it holds; cannot claim other nodes' attempts, widen capabilities after the lease or read other attempts; quarantine and revoke |
| Agent-supplied test commands | Run only through a named, versioned adapter with string arguments; never a shell string; the adapter is project-owned |
| Replay and forged results | Per-lease nonce set, session-key signature, current-fence check |
| Split brain, dead coordinator | Monotonic fences persisted in the snapshot; expiry is judged by the coordinator |
| Network exposure | Outbound-only from workers; the coordinator needs only Cezar's existing API; no Podman socket |
| Credential leakage | Tokens and session keys never appear in events or the snapshot; evidence is redacted by the existing evidence store |
| Resource exhaustion | Bounded evidence, argument count, spool and heartbeat payload |

## Rollout

Audited local rollout: ship the core and tests (this change), wire a local in-process worker to the executor
behind a flag, then enroll one remote host, drain it and revoke it, recording each step. Production release
follows the normal promoter.
