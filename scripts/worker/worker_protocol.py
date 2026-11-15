#!/usr/bin/env python3
"""Generic worker enrollment, heartbeat and fenced-lease protocol core (issue #214).

Project-neutral and transport-neutral: a coordinator (authority) and a worker-local
spool. Workers initiate every exchange (outbound only); the coordinator never calls
into a worker and no operation here accepts a shell string. Time is always passed in
by the caller, so tests and the coordinator's own clock decide freshness; a worker's
clock is never trusted.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
from dataclasses import dataclass, field
from typing import Any

PROTOCOL_VERSIONS = (1,)
SCHEMA_VERSION = 1
WORKER_STATES = ("registered", "healthy", "draining", "offline", "quarantined", "unsupported", "revoked")
# Typed outcomes: each failure mode is distinguishable and observable.
OUTCOMES = ("passed", "test_failed", "auth_failed", "unsupported_capability",
            "worker_disconnected", "started_but_lost", "stale_fence", "rejected_replay",
            "cancelled", "expired")
MAX_EVIDENCE_BYTES = 64 * 1024
MAX_SPOOL_ENTRIES = 32
MAX_ADAPTER_ARGS = 64


class ProtocolError(Exception):
    def __init__(self, outcome: str, message: str = ""):
        super().__init__(message or outcome)
        self.outcome = outcome


def _digest(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def _canonical(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()


def sign(key: str, payload: dict) -> str:
    return hmac.new(key.encode(), _canonical(payload), hashlib.sha256).hexdigest()


def validate_command(cmd: Any) -> dict:
    """A version-pinned adapter invocation; never a shell string."""
    if not isinstance(cmd, dict) or set(cmd) - {"adapter", "adapterVersion", "args"}:
        raise ProtocolError("unsupported_capability", "command must be adapter/adapterVersion/args")
    if not isinstance(cmd.get("adapter"), str) or not cmd.get("adapterVersion"):
        raise ProtocolError("unsupported_capability", "adapter and adapterVersion are required")
    args = cmd.get("args", [])
    if (not isinstance(args, list) or len(args) > MAX_ADAPTER_ARGS
            or not all(isinstance(a, str) for a in args)):
        raise ProtocolError("unsupported_capability", "args must be a bounded list of strings")
    return {"adapter": cmd["adapter"], "adapterVersion": str(cmd["adapterVersion"]), "args": list(args)}


@dataclass
class Worker:
    node_id: str
    token_hash: str
    state: str = "registered"
    protocol: int = 1
    capabilities: dict = field(default_factory=dict)
    last_heartbeat: float | None = None
    session_id: str | None = None
    session_key: str | None = None
    token_generation: int = 1


@dataclass
class Lease:
    attempt_id: str
    node_id: str
    session_id: str
    fence: int
    idempotency_key: str
    command: dict
    expires_at: float
    state: str = "leased"  # leased|started|cancel_requested|completed|expired|cancelled
    outcome: str | None = None
    seen_receipts: set = field(default_factory=set)


class Coordinator:
    """Authority over workers and attempts. In-memory here; `snapshot` is the durable form."""

    def __init__(self, *, heartbeat_ttl: float = 30.0, lease_ttl: float = 300.0):
        self.heartbeat_ttl = heartbeat_ttl
        self.lease_ttl = lease_ttl
        self.workers: dict[str, Worker] = {}
        self.leases: dict[str, Lease] = {}      # attempt_id -> current lease
        self.fences: dict[str, int] = {}        # attempt_id -> highest fence ever issued
        self.claims: dict[str, str] = {}        # idempotency key -> attempt_id
        self.events: list[dict] = []

    # -- observability -------------------------------------------------
    def _event(self, kind: str, **kw: Any) -> None:
        self.events.append({"kind": kind, **kw})

    # -- enrollment ----------------------------------------------------
    def enroll(self, node_id: str, capabilities: dict | None = None) -> str:
        """Issue a scoped enrollment token (shown once; only its hash is stored)."""
        token = secrets.token_urlsafe(32)
        prev = self.workers.get(node_id)
        gen = prev.token_generation + 1 if prev else 1
        self.workers[node_id] = Worker(node_id, _digest(token), capabilities=capabilities or {},
                                       token_generation=gen)
        self._event("enrolled", node=node_id, generation=gen)
        return token

    def rotate(self, node_id: str) -> str:
        w = self._worker(node_id)
        token = secrets.token_urlsafe(32)
        w.token_hash, w.token_generation = _digest(token), w.token_generation + 1
        w.session_id = w.session_key = None  # old session dies with the old credential
        self._event("rotated", node=node_id)
        return token

    def revoke(self, node_id: str) -> None:
        w = self._worker(node_id)
        w.state, w.session_id, w.session_key = "revoked", None, None
        for lease in self.leases.values():
            if lease.node_id == node_id and lease.state in ("leased", "started", "cancel_requested"):
                lease.state, lease.outcome = "cancelled", "auth_failed"
        self._event("revoked", node=node_id)

    def _worker(self, node_id: str) -> Worker:
        w = self.workers.get(node_id)
        if w is None:
            raise ProtocolError("auth_failed", "unknown node")
        return w

    def connect(self, node_id: str, token: str, versions: list[int],
                capabilities: dict, now: float) -> dict:
        """Open an ephemeral session. Negotiates the highest shared protocol version."""
        w = self.workers.get(node_id)
        if w is None or w.state == "revoked" or not hmac.compare_digest(w.token_hash, _digest(token)):
            self._event("auth_failed", node=node_id)
            raise ProtocolError("auth_failed", "invalid or revoked credential")
        shared = sorted(set(versions) & set(PROTOCOL_VERSIONS))
        if not shared:
            w.state = "unsupported"
            self._event("unsupported", node=node_id, versions=versions)
            raise ProtocolError("unsupported_capability", "no shared protocol version")
        w.protocol, w.capabilities = shared[-1], dict(capabilities)
        w.session_id, w.session_key = secrets.token_hex(16), secrets.token_hex(32)
        if w.state in ("registered", "offline", "unsupported", "healthy"):
            w.state = "healthy"
        w.last_heartbeat = now
        self._event("connected", node=node_id, session=w.session_id)
        return {"protocol": w.protocol, "sessionId": w.session_id, "sessionKey": w.session_key}

    def _check_session(self, node_id: str, session_id: str) -> Worker:
        w = self._worker(node_id)
        if w.state == "revoked" or w.session_id is None or not hmac.compare_digest(w.session_id, session_id):
            raise ProtocolError("auth_failed", "stale or unknown session")
        return w

    # -- heartbeats and states ----------------------------------------
    def heartbeat(self, node_id: str, session_id: str, capabilities: dict | None, now: float) -> str:
        w = self._check_session(node_id, session_id)
        if w.state == "quarantined":
            return w.state
        if capabilities is not None:
            w.capabilities = dict(capabilities)
        w.last_heartbeat = now
        if w.state == "offline":
            w.state = "healthy"
        return w.state

    def sweep(self, now: float) -> None:
        """Mark stale workers offline and expire leases; run by the coordinator's own clock."""
        for w in self.workers.values():
            if (w.state in ("healthy", "draining") and w.last_heartbeat is not None
                    and now - w.last_heartbeat > self.heartbeat_ttl):
                w.state = "offline"
                self._event("offline", node=w.node_id)
        for lease in self.leases.values():
            if lease.state in ("leased", "started", "cancel_requested") and now >= lease.expires_at:
                lease.outcome = "started_but_lost" if lease.state != "leased" else "worker_disconnected"
                lease.state = "expired"
                self._event("lease_expired", attempt=lease.attempt_id, outcome=lease.outcome)

    def drain(self, node_id: str) -> None:
        w = self._worker(node_id)
        if w.state in ("healthy", "registered"):
            w.state = "draining"

    def quarantine(self, node_id: str) -> None:
        self._worker(node_id).state = "quarantined"

    def schedulable(self, node_id: str, now: float) -> bool:
        w = self.workers.get(node_id)
        return bool(w and w.state == "healthy" and w.last_heartbeat is not None
                    and now - w.last_heartbeat <= self.heartbeat_ttl)

    # -- leases --------------------------------------------------------
    def claim(self, node_id: str, session_id: str, attempt_id: str, idempotency_key: str,
              command: dict, required: dict | None, now: float) -> Lease:
        w = self._check_session(node_id, session_id)
        self.sweep(now)
        if idempotency_key in self.claims:
            existing = self.leases[self.claims[idempotency_key]]
            if existing.node_id == node_id and existing.session_id == session_id:
                return existing  # idempotent retry returns the same lease and fence
            raise ProtocolError("stale_fence", "idempotency key already bound")
        if not self.schedulable(node_id, now):
            raise ProtocolError("worker_disconnected", f"worker not schedulable ({w.state})")
        cmd = validate_command(command)
        for key, want in (required or {}).items():
            if w.capabilities.get(key) != want:
                raise ProtocolError("unsupported_capability", f"missing capability {key}")
        cur = self.leases.get(attempt_id)
        if cur and cur.state in ("leased", "started", "cancel_requested"):
            raise ProtocolError("stale_fence", "attempt already leased")  # duplicate claim
        if cur and cur.state == "completed":
            raise ProtocolError("stale_fence", "attempt already completed")
        fence = self.fences.get(attempt_id, 0) + 1
        self.fences[attempt_id] = fence
        lease = Lease(attempt_id, node_id, session_id, fence, idempotency_key, cmd, now + self.lease_ttl)
        self.leases[attempt_id] = lease
        self.claims[idempotency_key] = attempt_id
        self._event("leased", attempt=attempt_id, node=node_id, fence=fence)
        return lease

    def _lease_for(self, attempt_id: str, node_id: str, session_id: str, fence: int) -> Lease:
        self._check_session(node_id, session_id)
        lease = self.leases.get(attempt_id)
        if (lease is None or lease.node_id != node_id or lease.session_id != session_id
                or lease.fence != fence or fence != self.fences.get(attempt_id)):
            self._event("stale_fence", attempt=attempt_id, node=node_id, fence=fence)
            raise ProtocolError("stale_fence", "fencing token is not current")
        return lease

    def renew(self, attempt_id: str, node_id: str, session_id: str, fence: int, now: float) -> float:
        lease = self._lease_for(attempt_id, node_id, session_id, fence)
        if lease.state not in ("leased", "started", "cancel_requested") or now >= lease.expires_at:
            raise ProtocolError("expired", "lease no longer live")
        lease.expires_at = now + self.lease_ttl
        return lease.expires_at

    def started(self, attempt_id: str, node_id: str, session_id: str, fence: int, now: float) -> None:
        lease = self._lease_for(attempt_id, node_id, session_id, fence)
        if lease.state == "leased" and now < lease.expires_at:
            lease.state = "started"

    def cancel(self, attempt_id: str) -> None:
        lease = self.leases.get(attempt_id)
        if lease and lease.state in ("leased", "started"):
            lease.state = "cancel_requested"

    def ack_cancel(self, attempt_id: str, node_id: str, session_id: str, fence: int) -> None:
        lease = self._lease_for(attempt_id, node_id, session_id, fence)
        if lease.state == "cancel_requested":
            lease.state, lease.outcome = "cancelled", "cancelled"

    def receipt(self, node_id: str, session_id: str, attempt_id: str, fence: int,
                nonce: str, outcome: str, evidence: str, mac: str, now: float) -> str:
        """Accept (or reject) a worker's result. Only the coordinator decides."""
        lease = self._lease_for(attempt_id, node_id, session_id, fence)
        w = self.workers[node_id]
        body = {"attempt": attempt_id, "fence": fence, "nonce": nonce, "outcome": outcome,
                "evidence": evidence}
        if not hmac.compare_digest(sign(w.session_key or "", body), mac):
            raise ProtocolError("auth_failed", "bad receipt signature")
        if nonce in lease.seen_receipts or lease.state == "completed":
            self._event("replay", attempt=attempt_id)
            raise ProtocolError("rejected_replay", "receipt already seen")
        if outcome not in ("passed", "test_failed"):
            raise ProtocolError("unsupported_capability", "workers may only report passed/test_failed")
        if len(evidence.encode()) > MAX_EVIDENCE_BYTES:
            raise ProtocolError("rejected_replay", "evidence over bound")
        if lease.state not in ("leased", "started") or now >= lease.expires_at:
            # expired or cancelled leases never produce a pass, even with a current fence
            raise ProtocolError("expired", "lease not live; evidence not accepted")
        lease.seen_receipts.add(nonce)
        lease.state, lease.outcome = "completed", outcome
        self._event("completed", attempt=attempt_id, outcome=outcome, fence=fence)
        return outcome

    # -- durability ----------------------------------------------------
    def snapshot(self) -> dict:
        """Durable lease state: restored coordinators keep fences, so a stale worker stays stale."""
        return {"schemaVersion": SCHEMA_VERSION, "fences": dict(self.fences), "claims": dict(self.claims),
                "leases": {k: {"node": v.node_id, "session": v.session_id, "fence": v.fence,
                               "state": v.state, "outcome": v.outcome, "expiresAt": v.expires_at,
                               "key": v.idempotency_key, "command": v.command}
                           for k, v in self.leases.items()}}

    @classmethod
    def restore(cls, snap: dict, **kw: Any) -> "Coordinator":
        if snap.get("schemaVersion") != SCHEMA_VERSION:
            raise ProtocolError("unsupported_capability", "unknown snapshot schema")
        c = cls(**kw)
        c.fences, c.claims = dict(snap["fences"]), dict(snap["claims"])
        for k, v in snap["leases"].items():
            state, outcome = v["state"], v["outcome"]
            if state in ("leased", "started", "cancel_requested"):
                # sessions do not survive a coordinator restart; the work is lost until reclaimed
                state, outcome = "expired", "started_but_lost" if state != "leased" else "worker_disconnected"
            c.leases[k] = Lease(k, v["node"], v["session"], v["fence"], v["key"], v["command"],
                                v["expiresAt"], state, outcome)
        return c


class Spool:
    """Worker-local bounded job spool: finished results wait here across a disconnect."""

    def __init__(self, limit: int = MAX_SPOOL_ENTRIES):
        self.limit, self.entries = limit, []

    def put(self, entry: dict) -> bool:
        if len(self.entries) >= self.limit:
            self.entries.pop(0)  # bounded retention: oldest result dropped, never grows unbounded
        self.entries.append(entry)
        return True

    def flush(self, send) -> list:
        """Report after reconnect. `send` raises ProtocolError for rejected results; those are dropped
        (the coordinator decided), transport errors leave the entry spooled."""
        results = []
        for entry in list(self.entries):
            try:
                results.append((entry, send(entry)))
            except ProtocolError as e:
                results.append((entry, e.outcome))
            except ConnectionError:
                break
            self.entries.remove(entry)
        return results
