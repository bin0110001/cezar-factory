#!/usr/bin/env python3
"""Durable single-active release candidate state machine with an ownership lease.

One SQLite database holds every candidate. A partial UNIQUE index guarantees at
most one nonterminal candidate per project, whatever the trigger or process.
Every mutation is a compare-and-set on (candidate id, revision, fencing token)
inside a BEGIN IMMEDIATE transaction, so a stale worker, a delayed result of an
obsolete revision, or a replayed command cannot change state. Nothing here is
wired into live promotion; see docs/candidate-state-machine.md.
"""

from __future__ import annotations

import json
import pathlib
import sqlite3
import time
import uuid
from typing import Any, Callable, Iterable

STATES = (
    "requested", "admitted", "snapshotting", "validating", "repair-required",
    "revalidating", "ready", "awaiting-approval", "promoting", "activating",
    "promoted", "abandoned", "failed", "canceled",
)
TERMINAL = frozenset({"promoted", "abandoned", "failed", "canceled"})
NONTERMINAL = tuple(s for s in STATES if s not in TERMINAL)

TRANSITIONS: dict[str, frozenset[str]] = {
    "requested": frozenset({"admitted", "failed"}),
    "admitted": frozenset({"snapshotting", "failed"}),
    "snapshotting": frozenset({"validating", "failed"}),
    "validating": frozenset({"repair-required", "ready", "failed"}),
    "repair-required": frozenset({"revalidating", "failed"}),
    "revalidating": frozenset({"repair-required", "ready", "failed"}),
    "ready": frozenset({"awaiting-approval", "promoting", "failed"}),
    "awaiting-approval": frozenset({"promoting", "failed"}),
    "promoting": frozenset({"activating", "failed"}),
    "activating": frozenset({"promoted", "failed"}),
}
# Terminal states abandoned/canceled are reachable only through cancel().
RECEIPT_STATES = frozenset({"promoting", "activating"})
EXECUTING_STATES = frozenset({"validating", "revalidating"})

SCHEMA = """
CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  state TEXT NOT NULL,
  source_dev_sha TEXT NOT NULL,
  base_stable_sha TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  candidate_sha TEXT,
  config_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  lock_owner TEXT,
  lease_expires REAL,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  pending_triggers TEXT NOT NULL DEFAULT '[]'
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_candidate_per_project
  ON candidates(project)
  WHERE state NOT IN ('promoted','abandoned','failed','canceled');
CREATE TABLE IF NOT EXISTS project_fence (
  project TEXT PRIMARY KEY,
  token INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS revisions (
  candidate_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  sha TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (candidate_id, revision),
  UNIQUE (candidate_id, sha)
);
CREATE TABLE IF NOT EXISTS test_runs (
  run_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  sha TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  evidence TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_running_test_per_candidate
  ON test_runs(candidate_id) WHERE status = 'running';
CREATE TABLE IF NOT EXISTS receipts (
  candidate_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (candidate_id, kind)
);
CREATE TABLE IF NOT EXISTS pending_requests (
  project TEXT PRIMARY KEY,
  source_dev_sha TEXT NOT NULL,
  base_stable_sha TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  triggers TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  result TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  candidate_id TEXT,
  action TEXT NOT NULL,
  actor TEXT,
  reason TEXT,
  detail TEXT,
  at TEXT NOT NULL
);
"""


class CandidateError(Exception):
    """Base class; every rejection leaves durable state unchanged."""


class IllegalTransition(CandidateError):
    pass


class StaleFence(CandidateError):
    pass


class StaleRevision(CandidateError):
    pass


class LeaseHeld(CandidateError):
    pass


class NotFound(CandidateError):
    pass


class Conflict(CandidateError):
    pass


def utc_iso(epoch: float) -> str:
    import datetime as dt
    return dt.datetime.fromtimestamp(epoch, dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _row(cur: sqlite3.Cursor) -> dict[str, Any] | None:
    row = cur.fetchone()
    if row is None:
        return None
    out = dict(zip([c[0] for c in cur.description], row))
    if "pending_triggers" in out:
        out["pending_triggers"] = json.loads(out["pending_triggers"])
    return out


class CandidateStore:
    def __init__(self, path: str | pathlib.Path, clock: Callable[[], float] = time.time, busy_timeout: float = 30.0):
        self.path = str(path)
        self.clock = clock
        self.busy_timeout = busy_timeout
        pathlib.Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        conn = self._conn()
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(SCHEMA)
        finally:
            conn.close()

    # -- plumbing -----------------------------------------------------------
    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=self.busy_timeout, isolation_level=None)
        conn.execute("PRAGMA busy_timeout=%d" % int(self.busy_timeout * 1000))
        return conn

    def _tx(self, fn: Callable[[sqlite3.Connection, float], Any], idem_key: str | None = None) -> Any:
        conn = self._conn()
        try:
            conn.execute("BEGIN IMMEDIATE")
            try:
                if idem_key is not None:
                    hit = conn.execute("SELECT result FROM idempotency WHERE key=?", (idem_key,)).fetchone()
                    if hit:
                        conn.execute("ROLLBACK")
                        out = json.loads(hit[0])
                        if isinstance(out, dict):
                            out["replayed"] = True
                        return out
                result = fn(conn, self.clock())
                if idem_key is not None:
                    conn.execute("INSERT INTO idempotency(key,result) VALUES(?,?)", (idem_key, json.dumps(result, sort_keys=True)))
                conn.execute("COMMIT")
                return result
            except BaseException:
                if conn.in_transaction:
                    conn.execute("ROLLBACK")
                raise
        finally:
            conn.close()

    @staticmethod
    def _audit(conn, now, project, cid, action, actor=None, reason=None, detail=None):
        conn.execute(
            "INSERT INTO audit(project,candidate_id,action,actor,reason,detail,at) VALUES(?,?,?,?,?,?,?)",
            (project, cid, action, actor, reason, json.dumps(detail, sort_keys=True) if detail is not None else None, utc_iso(now)),
        )

    @staticmethod
    def _load(conn, cid: str) -> dict[str, Any]:
        cur = conn.execute("SELECT * FROM candidates WHERE id=?", (cid,))
        row = _row(cur)
        if row is None:
            raise NotFound(f"candidate {cid} not found")
        return row

    def _guard(self, conn, now, cid, token, revision=None, require_lease=True) -> dict[str, Any]:
        cand = self._load(conn, cid)
        if cand["state"] in TERMINAL:
            raise IllegalTransition(f"candidate {cid} is terminal ({cand['state']})")
        if token != cand["fencing_token"]:
            raise StaleFence(f"fencing token {token} is stale (current {cand['fencing_token']})")
        if require_lease and (cand["lease_expires"] is None or cand["lease_expires"] <= now):
            raise StaleFence("lease expired; re-acquire before mutating")
        if revision is not None and revision != cand["revision"]:
            raise StaleRevision(f"revision {revision} is obsolete (current {cand['revision']})")
        return cand

    @staticmethod
    def _touch(conn, now, cid, **fields):
        fields["updated_at"] = utc_iso(now)
        cols = ", ".join(f"{k}=?" for k in fields)
        conn.execute(f"UPDATE candidates SET {cols} WHERE id=?", (*fields.values(), cid))

    @staticmethod
    def _bump_fence(conn, project) -> int:
        conn.execute("INSERT INTO project_fence(project,token) VALUES(?,1) ON CONFLICT(project) DO UPDATE SET token=token+1", (project,))
        return conn.execute("SELECT token FROM project_fence WHERE project=?", (project,)).fetchone()[0]

    # -- requests and admission --------------------------------------------
    def request(self, project: str, trigger: str, source_dev_sha: str, base_stable_sha: str, config_hash: str,
                idempotency_key: str | None = None) -> dict[str, Any]:
        """Admit a candidate, or record one pending request for the next candidate.

        Triggers received while a candidate is active are appended to the single
        pending request; its original SHAs are never overwritten.
        """
        def run(conn, now):
            cid = uuid.uuid4().hex
            stamp = utc_iso(now)
            try:
                conn.execute("SAVEPOINT admit")
                conn.execute(
                    "INSERT INTO candidates(id,project,state,source_dev_sha,base_stable_sha,revision,config_hash,created_at,updated_at,pending_triggers)"
                    " VALUES(?,?,?,?,?,0,?,?,?,?)",
                    (cid, project, "requested", source_dev_sha, base_stable_sha, config_hash, stamp, stamp, json.dumps([trigger])),
                )
                conn.execute("RELEASE admit")
            except sqlite3.IntegrityError:
                conn.execute("ROLLBACK TO admit")
                conn.execute("RELEASE admit")
                return self._record_pending(conn, now, project, trigger, source_dev_sha, base_stable_sha, config_hash)
            self._audit(conn, now, project, cid, "requested", detail={"trigger": trigger})
            self._touch(conn, now, cid, state="admitted")
            self._audit(conn, now, project, cid, "transition", detail={"from": "requested", "to": "admitted"})
            return {"outcome": "admitted", "candidate_id": cid, "project": project}
        return self._tx(run, idempotency_key)

    def _record_pending(self, conn, now, project, trigger, sha, base, config_hash) -> dict[str, Any]:
        row = conn.execute("SELECT triggers FROM pending_requests WHERE project=?", (project,)).fetchone()
        stamp = utc_iso(now)
        if row is None:
            conn.execute(
                "INSERT INTO pending_requests(project,source_dev_sha,base_stable_sha,config_hash,triggers,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                (project, sha, base, config_hash, json.dumps([trigger]), stamp, stamp),
            )
        else:
            triggers = json.loads(row[0]) + [trigger]
            conn.execute("UPDATE pending_requests SET triggers=?, updated_at=? WHERE project=?", (json.dumps(triggers), stamp, project))
        active = conn.execute("SELECT id FROM candidates WHERE project=? AND state NOT IN ('promoted','abandoned','failed','canceled')", (project,)).fetchone()
        self._audit(conn, now, project, active[0] if active else None, "pending", detail={"trigger": trigger})
        return {"outcome": "pending", "candidate_id": active[0] if active else None, "project": project}

    def admit_pending(self, project: str, idempotency_key: str | None = None) -> dict[str, Any]:
        """Turn the pending request into a candidate, only once none is active."""
        def run(conn, now):
            if conn.execute("SELECT 1 FROM candidates WHERE project=? AND state NOT IN ('promoted','abandoned','failed','canceled')", (project,)).fetchone():
                return {"outcome": "blocked", "project": project}
            row = conn.execute("SELECT source_dev_sha,base_stable_sha,config_hash,triggers FROM pending_requests WHERE project=?", (project,)).fetchone()
            if row is None:
                return {"outcome": "none", "project": project}
            cid = uuid.uuid4().hex
            stamp = utc_iso(now)
            conn.execute(
                "INSERT INTO candidates(id,project,state,source_dev_sha,base_stable_sha,revision,config_hash,created_at,updated_at,pending_triggers)"
                " VALUES(?,?,?,?,?,0,?,?,?,?)",
                (cid, project, "admitted", row[0], row[1], row[2], stamp, stamp, row[3]),
            )
            conn.execute("DELETE FROM pending_requests WHERE project=?", (project,))
            self._audit(conn, now, project, cid, "admitted-from-pending", detail={"triggers": json.loads(row[3])})
            return {"outcome": "admitted", "candidate_id": cid, "project": project}
        return self._tx(run, idempotency_key)

    # -- lease ---------------------------------------------------------------
    def acquire_lease(self, candidate_id: str, owner: str, ttl: float) -> int:
        """Take or renew the lease. A new owner (or a re-acquire after expiry)
        receives a strictly higher fencing token; a live lease of another owner
        is refused."""
        def run(conn, now):
            cand = self._load(conn, candidate_id)
            if cand["state"] in TERMINAL:
                raise IllegalTransition("candidate is terminal")
            live = cand["lease_expires"] is not None and cand["lease_expires"] > now
            if live and cand["lock_owner"] != owner:
                raise LeaseHeld(f"lease held by {cand['lock_owner']}")
            if live:
                token = cand["fencing_token"]
            else:
                token = self._bump_fence(conn, cand["project"])
                self._audit(conn, now, cand["project"], candidate_id, "lease-acquired", actor=owner, detail={"token": token, "previous_owner": cand["lock_owner"]})
            self._touch(conn, now, candidate_id, lock_owner=owner, lease_expires=now + ttl, fencing_token=token)
            return token
        return self._tx(run)

    def heartbeat(self, candidate_id: str, owner: str, token: int, ttl: float) -> None:
        def run(conn, now):
            cand = self._guard(conn, now, candidate_id, token)
            if cand["lock_owner"] != owner:
                raise StaleFence("not the lease owner")
            self._touch(conn, now, candidate_id, lease_expires=now + ttl)
        self._tx(run)

    # -- transitions ---------------------------------------------------------
    def transition(self, candidate_id: str, to_state: str, token: int, revision: int,
                   idempotency_key: str | None = None, reason: str | None = None) -> dict[str, Any]:
        if to_state not in STATES:
            raise IllegalTransition(f"unknown state {to_state}")

        def run(conn, now):
            cand = self._guard(conn, now, candidate_id, token, revision)
            frm = cand["state"]
            if to_state not in TRANSITIONS.get(frm, frozenset()):
                raise IllegalTransition(f"{frm} -> {to_state} is not legal")
            if to_state in ("repair-required", "ready") and frm in EXECUTING_STATES:
                run_row = conn.execute("SELECT status,result FROM test_runs WHERE candidate_id=? AND revision=? ORDER BY started_at DESC, rowid DESC LIMIT 1", (candidate_id, cand["revision"])).fetchone()
                if conn.execute("SELECT 1 FROM test_runs WHERE candidate_id=? AND status='running'", (candidate_id,)).fetchone():
                    raise IllegalTransition("a test run is still executing")
                if to_state == "ready" and not (run_row and run_row[1] == "passed"):
                    raise IllegalTransition("ready requires a passed test run for the current revision")
                if to_state == "repair-required" and not (run_row and run_row[1] == "failed"):
                    raise IllegalTransition("repair-required requires a failed test run for the current revision")
            if to_state == "revalidating":
                raise IllegalTransition("use new_revision() to enter revalidating")
            if to_state == "validating" and cand["candidate_sha"] is None:
                raise IllegalTransition("snapshot() must record the candidate SHA first")
            if to_state == "promoted" and conn.execute("SELECT 1 FROM receipts WHERE candidate_id=? AND kind='activation'", (candidate_id,)).fetchone() is None:
                raise IllegalTransition("promoted requires an activation receipt")
            if to_state == "activating" and conn.execute("SELECT 1 FROM receipts WHERE candidate_id=? AND kind='promotion'", (candidate_id,)).fetchone() is None:
                raise IllegalTransition("activating requires a promotion receipt")
            fields: dict[str, Any] = {"state": to_state}
            if to_state in TERMINAL:
                fields.update(lock_owner=None, lease_expires=None)
            self._touch(conn, now, candidate_id, **fields)
            self._audit(conn, now, cand["project"], candidate_id, "transition", reason=reason, detail={"from": frm, "to": to_state, "revision": cand["revision"]})
            return {"candidate_id": candidate_id, "state": to_state, "revision": cand["revision"]}
        return self._tx(run, idempotency_key)

    def snapshot(self, candidate_id: str, token: int, sha: str, idempotency_key: str | None = None) -> dict[str, Any]:
        """Record the immutable candidate SHA as revision 1 (state snapshotting)."""
        def run(conn, now):
            cand = self._guard(conn, now, candidate_id, token, 0)
            if cand["state"] != "snapshotting":
                raise IllegalTransition("snapshot() is only legal in snapshotting")
            self._insert_revision(conn, now, candidate_id, 1, sha)
            self._touch(conn, now, candidate_id, revision=1, candidate_sha=sha)
            self._audit(conn, now, cand["project"], candidate_id, "snapshot", detail={"sha": sha, "revision": 1})
            return {"candidate_id": candidate_id, "revision": 1, "sha": sha}
        return self._tx(run, idempotency_key)

    def new_revision(self, candidate_id: str, token: int, revision: int, sha: str, idempotency_key: str | None = None) -> dict[str, Any]:
        """From repair-required, record a repaired SHA as the next revision and
        enter revalidating. The previous revision's evidence stays immutable."""
        def run(conn, now):
            cand = self._guard(conn, now, candidate_id, token, revision)
            if cand["state"] != "repair-required":
                raise IllegalTransition("new_revision() is only legal in repair-required")
            nxt = cand["revision"] + 1
            self._insert_revision(conn, now, candidate_id, nxt, sha)
            self._touch(conn, now, candidate_id, revision=nxt, candidate_sha=sha, state="revalidating")
            self._audit(conn, now, cand["project"], candidate_id, "transition", detail={"from": "repair-required", "to": "revalidating", "revision": nxt, "sha": sha})
            return {"candidate_id": candidate_id, "state": "revalidating", "revision": nxt, "sha": sha}
        return self._tx(run, idempotency_key)

    @staticmethod
    def _insert_revision(conn, now, cid, revision, sha):
        try:
            conn.execute("INSERT INTO revisions(candidate_id,revision,sha,created_at) VALUES(?,?,?,?)", (cid, revision, sha, utc_iso(now)))
        except sqlite3.IntegrityError as exc:
            raise Conflict(f"revision SHA {sha} is not unique for candidate") from exc

    # -- test evidence ---------------------------------------------------------
    def start_test_run(self, candidate_id: str, token: int, revision: int, run_id: str, idempotency_key: str | None = None) -> dict[str, Any]:
        def run(conn, now):
            cand = self._guard(conn, now, candidate_id, token, revision)
            if cand["state"] not in EXECUTING_STATES:
                raise IllegalTransition("test runs start only while validating/revalidating")
            if conn.execute("SELECT 1 FROM test_runs WHERE candidate_id=? AND revision=?", (candidate_id, revision)).fetchone():
                raise Conflict("revision already has test evidence; evidence is immutable")
            try:
                conn.execute("INSERT INTO test_runs(run_id,candidate_id,revision,sha,status,started_at) VALUES(?,?,?,?, 'running', ?)",
                             (run_id, candidate_id, revision, cand["candidate_sha"], utc_iso(now)))
            except sqlite3.IntegrityError as exc:
                raise Conflict("a revision is already executing") from exc
            self._audit(conn, now, cand["project"], candidate_id, "test-run-started", detail={"run_id": run_id, "revision": revision})
            return {"run_id": run_id, "revision": revision}
        return self._tx(run, idempotency_key)

    def record_result(self, candidate_id: str, token: int, revision: int, run_id: str, result: str,
                      evidence: Any = None, idempotency_key: str | None = None) -> dict[str, Any]:
        """Store a finished run's result. Rejected when the fence or revision is
        stale, so a delayed obsolete result can never mark a candidate green."""
        if result not in ("passed", "failed"):
            raise CandidateError("result must be passed or failed")

        def run(conn, now):
            cand = self._guard(conn, now, candidate_id, token, revision)
            row = conn.execute("SELECT status,revision FROM test_runs WHERE run_id=? AND candidate_id=?", (run_id, candidate_id)).fetchone()
            if row is None:
                raise NotFound(f"test run {run_id} not found")
            if row[1] != cand["revision"]:
                raise StaleRevision("test run belongs to an obsolete revision")
            if row[0] != "running":
                raise Conflict("test run already finished; evidence is immutable")
            conn.execute("UPDATE test_runs SET status='finished', result=?, evidence=?, finished_at=? WHERE run_id=?",
                         (result, json.dumps(evidence, sort_keys=True), utc_iso(now), run_id))
            self._audit(conn, now, cand["project"], candidate_id, "test-result", detail={"run_id": run_id, "result": result, "revision": revision})
            return {"run_id": run_id, "result": result, "revision": revision}
        return self._tx(run, idempotency_key)

    def record_receipt(self, candidate_id: str, token: int, revision: int, kind: str, receipt_id: str, payload: Any) -> dict[str, Any]:
        """Persist a promotion/activation receipt once per candidate and kind.
        A replay with the same receipt id returns the original; a different id conflicts."""
        if kind not in ("promotion", "activation"):
            raise CandidateError("kind must be promotion or activation")

        def run(conn, now):
            cand = self._guard(conn, now, candidate_id, token, revision)
            existing = conn.execute("SELECT receipt_id FROM receipts WHERE candidate_id=? AND kind=?", (candidate_id, kind)).fetchone()
            if existing:
                if existing[0] != receipt_id:
                    raise Conflict(f"{kind} receipt already recorded as {existing[0]}")
                return {"kind": kind, "receipt_id": receipt_id, "replayed": True}
            expected = "promoting" if kind == "promotion" else "activating"
            if cand["state"] != expected:
                raise IllegalTransition(f"{kind} receipt requires state {expected}")
            conn.execute("INSERT INTO receipts(candidate_id,kind,receipt_id,payload,created_at) VALUES(?,?,?,?,?)",
                         (candidate_id, kind, receipt_id, json.dumps(payload, sort_keys=True), utc_iso(now)))
            self._audit(conn, now, cand["project"], candidate_id, "receipt", detail={"kind": kind, "receipt_id": receipt_id})
            return {"kind": kind, "receipt_id": receipt_id}
        return self._tx(run)

    # -- cancel / abandon ----------------------------------------------------
    def cancel(self, candidate_id: str, actor: str, reason: str, abandon: bool = False) -> dict[str, Any]:
        """Operator action: terminal canceled/abandoned with an audit row. Bumps
        the fencing token so the previous owner can no longer write."""
        if not actor or not reason:
            raise CandidateError("actor and reason are required")

        def run(conn, now):
            cand = self._load(conn, candidate_id)
            state = "abandoned" if abandon else "canceled"
            if cand["state"] in TERMINAL:
                if cand["state"] == state:
                    return {"candidate_id": candidate_id, "state": state, "replayed": True}
                raise IllegalTransition(f"candidate already {cand['state']}")
            token = self._bump_fence(conn, cand["project"])
            self._touch(conn, now, candidate_id, state=state, lock_owner=None, lease_expires=None, fencing_token=token)
            self._audit(conn, now, cand["project"], candidate_id, state, actor=actor, reason=reason, detail={"from": cand["state"]})
            return {"candidate_id": candidate_id, "state": state}
        return self._tx(run)

    # -- reconciliation --------------------------------------------------------
    def reconcile(self, project: str, owner: str, ttl: float, probes: "Probes") -> dict[str, Any]:
        """Startup recovery for a project's active candidate. Takes over an
        expired lease with a higher fencing token, then reconciles the database
        against refs, runs and artifacts. Never admits candidate #2."""
        active = self.active(project)
        if active is None:
            return {"outcome": "idle", "project": project}
        cid = active["id"]
        try:
            token = self.acquire_lease(cid, owner, ttl)
        except LeaseHeld:
            return {"outcome": "lease-held", "candidate_id": cid, "owner": active["lock_owner"]}
        actions: list[str] = []

        def run(conn, now):
            cand = self._guard(conn, now, cid, token)
            if cand["candidate_sha"] is not None:
                ref = probes.ref_sha(cand)
                if ref != cand["candidate_sha"]:
                    self._fail(conn, now, cand, f"ref mismatch: recorded {cand['candidate_sha']} observed {ref}")
                    actions.append("failed:ref-mismatch")
                    return
            live = set(probes.live_runs(cand))
            for run_id, in conn.execute("SELECT run_id FROM test_runs WHERE candidate_id=? AND status='running'", (cid,)).fetchall():
                if run_id not in live:
                    conn.execute("UPDATE test_runs SET status='finished', result='failed', evidence=?, finished_at=? WHERE run_id=?",
                                 (json.dumps({"lost": True}), utc_iso(now), run_id))
                    self._audit(conn, now, cand["project"], cid, "test-run-lost", actor=owner, detail={"run_id": run_id})
                    actions.append(f"run-lost:{run_id}")
            if cand["state"] in ("ready", "awaiting-approval"):
                for rev, in conn.execute("SELECT revision FROM test_runs WHERE candidate_id=? AND result='passed'", (cid,)).fetchall():
                    if not probes.artifact_exists(cand, rev):
                        self._fail(conn, now, cand, f"artifact missing for revision {rev}")
                        actions.append("failed:artifact-missing")
                        break
        self._tx(run)
        final = self._tx(lambda conn, now: self._load(conn, cid))
        return {"outcome": "reconciled", "candidate_id": cid, "token": token, "state": final["state"], "actions": actions}

    def _fail(self, conn, now, cand, reason):
        self._touch(conn, now, cand["id"], state="failed", lock_owner=None, lease_expires=None)
        self._audit(conn, now, cand["project"], cand["id"], "transition", reason=reason, detail={"from": cand["state"], "to": "failed"})

    # -- reads -----------------------------------------------------------------
    def active(self, project: str) -> dict[str, Any] | None:
        return self._read("SELECT * FROM candidates WHERE project=? AND state NOT IN ('promoted','abandoned','failed','canceled')", (project,))

    def get(self, candidate_id: str) -> dict[str, Any]:
        row = self._read("SELECT * FROM candidates WHERE id=?", (candidate_id,))
        if row is None:
            raise NotFound(candidate_id)
        conn = self._conn()
        try:
            row["test_run_ids"] = [r[0] for r in conn.execute("SELECT run_id FROM test_runs WHERE candidate_id=? ORDER BY started_at, rowid", (candidate_id,))]
            row["receipts"] = {r[0]: {"receipt_id": r[1], "payload": json.loads(r[2])} for r in conn.execute("SELECT kind,receipt_id,payload FROM receipts WHERE candidate_id=?", (candidate_id,))}
            row["revisions"] = [{"revision": r[0], "sha": r[1]} for r in conn.execute("SELECT revision,sha FROM revisions WHERE candidate_id=? ORDER BY revision", (candidate_id,))]
        finally:
            conn.close()
        return row

    def pending(self, project: str) -> dict[str, Any] | None:
        row = self._read("SELECT * FROM pending_requests WHERE project=?", (project,))
        if row:
            row["triggers"] = json.loads(row["triggers"])
        return row

    def audit_log(self, project: str) -> list[dict[str, Any]]:
        conn = self._conn()
        try:
            cur = conn.execute("SELECT * FROM audit WHERE project=? ORDER BY seq", (project,))
            cols = [c[0] for c in cur.description]
            return [dict(zip(cols, r)) for r in cur.fetchall()]
        finally:
            conn.close()

    def _read(self, sql: str, args: Iterable[Any]) -> dict[str, Any] | None:
        conn = self._conn()
        try:
            return _row(conn.execute(sql, tuple(args)))
        finally:
            conn.close()


class Probes:
    """Injected observers of the outside world used by reconcile()."""

    def ref_sha(self, candidate: dict[str, Any]) -> str | None:
        return candidate["candidate_sha"]

    def live_runs(self, candidate: dict[str, Any]) -> Iterable[str]:
        return ()

    def artifact_exists(self, candidate: dict[str, Any], revision: int) -> bool:
        return True
