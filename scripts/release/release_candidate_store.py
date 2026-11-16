"""Durable single-active release candidate store (#590).

Library only (Factory scripts run from workflow steps). One SQLite file holds candidates, revisions, test
evidence, pending requests and an audit log. The invariant "at most one nonterminal candidate per project" is
enforced by the database (a partial unique index), not by a lock; every mutation also checks the fencing token and
the row version, so a stale owner or an obsolete revision can never write a result.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from typing import Any, Iterator

TERMINAL = ("promoted", "abandoned", "failed", "canceled")
TRANSITIONS: dict[str, tuple[str, ...]] = {
    "requested": ("admitted",),
    "admitted": ("snapshotting",),
    "snapshotting": ("validating",),
    "validating": ("repair-required", "ready"),
    "repair-required": ("revalidating",),
    "revalidating": ("repair-required", "ready"),
    "ready": ("awaiting-approval", "promoting"),
    "awaiting-approval": ("promoting",),
    "promoting": ("activating",),
    "activating": ("promoted",),
}
for _s in list(TRANSITIONS):
    TRANSITIONS[_s] = TRANSITIONS[_s] + ("abandoned", "failed", "canceled")

SCHEMA = """
CREATE TABLE IF NOT EXISTS candidates(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL, revision INTEGER NOT NULL,
  dev_sha TEXT NOT NULL, base_stable_sha TEXT NOT NULL, candidate_sha TEXT, config_hash TEXT NOT NULL,
  owner TEXT, lease_expires REAL, fencing INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_per_project ON candidates(project_id)
  WHERE state NOT IN ('promoted','abandoned','failed','canceled');
CREATE TABLE IF NOT EXISTS revisions(
  candidate_id TEXT NOT NULL, revision INTEGER NOT NULL, dev_sha TEXT NOT NULL, candidate_sha TEXT NOT NULL, created_at REAL NOT NULL,
  PRIMARY KEY(candidate_id, revision), UNIQUE(candidate_id, candidate_sha));
CREATE TABLE IF NOT EXISTS results(
  run_id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL, evidence TEXT NOT NULL, at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS pending(
  project_id TEXT PRIMARY KEY, history TEXT NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS idempotency(key TEXT PRIMARY KEY, outcome TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS receipts(receipt_id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, body TEXT NOT NULL, at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id TEXT, project_id TEXT, actor TEXT, event TEXT, detail TEXT, at REAL);
"""


class StoreError(RuntimeError):
    """A mutation was refused: stale fencing token, stale version/revision, illegal transition or evidence conflict."""


class CandidateStore:
    def __init__(self, path: str, *, busy_timeout: float = 30.0):
        self.path, self.busy_timeout = path, busy_timeout
        with self._tx() as db:
            for stmt in SCHEMA.split(";"):
                if stmt.strip():
                    db.execute(stmt)

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path, timeout=self.busy_timeout, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.execute("COMMIT")
        except BaseException:
            if db.in_transaction:
                db.execute("ROLLBACK")
            raise
        finally:
            db.close()

    @staticmethod
    def _audit(db: sqlite3.Connection, cand: Any, actor: str, event: str, detail: Any, now: float, project: str | None = None) -> None:
        db.execute("INSERT INTO audit(candidate_id,project_id,actor,event,detail,at) VALUES(?,?,?,?,?,?)",
                   (cand["id"] if cand else None, project or (cand["project_id"] if cand else None), actor, event, json.dumps(detail, sort_keys=True), now))

    @staticmethod
    def _get(db: sqlite3.Connection, cid: str) -> sqlite3.Row:
        row = db.execute("SELECT * FROM candidates WHERE id=?", (cid,)).fetchone()
        if row is None:
            raise StoreError(f"unknown candidate {cid}")
        return row

    # ---- requests -------------------------------------------------------------------------------------------------
    def request(self, project_id: str, *, trigger: str, reason: str, dev_sha: str, base_stable_sha: str, config_hash: str,
                now: float, idempotency_key: str | None = None) -> dict[str, Any]:
        """Admit a new candidate only if the project has none active; otherwise fold into ONE pending request.

        Replaying the same idempotency key returns the original outcome and changes nothing."""
        with self._tx() as db:
            if idempotency_key:
                seen = db.execute("SELECT outcome FROM idempotency WHERE key=?", (idempotency_key,)).fetchone()
                if seen:
                    return {**json.loads(seen["outcome"]), "replayed": True}
            active = db.execute("SELECT * FROM candidates WHERE project_id=? AND state NOT IN ('promoted','abandoned','failed','canceled')", (project_id,)).fetchone()
            entry = {"trigger": trigger, "reason": reason, "devSha": dev_sha, "at": now}
            if active is None:
                cid = "cand-" + uuid.uuid4().hex[:16]
                db.execute("INSERT INTO candidates(id,project_id,state,version,revision,dev_sha,base_stable_sha,config_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                           (cid, project_id, "requested", 0, 0, dev_sha, base_stable_sha, config_hash, now, now))
                outcome = {"result": "admitted", "candidateId": cid}
                self._audit(db, {"id": cid, "project_id": project_id}, trigger, "requested", entry, now)
            else:
                row = db.execute("SELECT history FROM pending WHERE project_id=?", (project_id,)).fetchone()
                history = (json.loads(row["history"]) if row else []) + [entry]
                db.execute("INSERT INTO pending(project_id,history,updated_at) VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET history=excluded.history, updated_at=excluded.updated_at",
                           (project_id, json.dumps(history), now))
                outcome = {"result": "pending", "activeCandidateId": active["id"], "pendingCount": len(history)}
                self._audit(db, active, trigger, "pending-request", entry, now)
            if idempotency_key:
                db.execute("INSERT INTO idempotency(key,outcome) VALUES(?,?)", (idempotency_key, json.dumps(outcome)))
            return outcome

    def pending_request(self, project_id: str) -> dict[str, Any] | None:
        with self._tx() as db:
            row = db.execute("SELECT * FROM pending WHERE project_id=?", (project_id,)).fetchone()
            return {"history": json.loads(row["history"]), "updatedAt": row["updated_at"]} if row else None

    def take_pending(self, project_id: str) -> dict[str, Any] | None:
        """Hand the pending request to the caller once the project has no active candidate; it is never auto-started."""
        with self._tx() as db:
            if db.execute("SELECT 1 FROM candidates WHERE project_id=? AND state NOT IN ('promoted','abandoned','failed','canceled')", (project_id,)).fetchone():
                return None
            row = db.execute("SELECT * FROM pending WHERE project_id=?", (project_id,)).fetchone()
            if not row:
                return None
            db.execute("DELETE FROM pending WHERE project_id=?", (project_id,))
            return {"history": json.loads(row["history"])}

    # ---- ownership ------------------------------------------------------------------------------------------------
    def acquire(self, cid: str, owner: str, *, now: float, ttl: float) -> int:
        """Take or renew the lease. The fencing token increases whenever ownership changes, never otherwise."""
        with self._tx() as db:
            c = self._get(db, cid)
            if c["state"] in TERMINAL:
                raise StoreError("candidate is terminal")
            held = c["owner"] is not None and c["lease_expires"] is not None and c["lease_expires"] > now
            if held and c["owner"] != owner:
                raise StoreError(f"lease held by {c['owner']}")
            fencing = c["fencing"] if c["owner"] == owner else c["fencing"] + 1
            db.execute("UPDATE candidates SET owner=?, lease_expires=?, fencing=?, updated_at=? WHERE id=?", (owner, now + ttl, fencing, now, cid))
            self._audit(db, c, owner, "lease", {"fencing": fencing}, now)
            return fencing

    def _guard(self, db: sqlite3.Connection, cid: str, fencing: int, version: int | None, now: float) -> sqlite3.Row:
        c = self._get(db, cid)
        if c["state"] in TERMINAL:
            raise StoreError("candidate is terminal")
        if c["fencing"] != fencing:
            raise StoreError("stale fencing token")
        if c["lease_expires"] is None or c["lease_expires"] <= now:
            raise StoreError("lease expired")
        if version is not None and c["version"] != version:
            raise StoreError("stale candidate version")
        return c

    def transition(self, cid: str, to: str, *, fencing: int, version: int, now: float, actor: str = "owner") -> dict[str, Any]:
        with self._tx() as db:
            c = self._guard(db, cid, fencing, version, now)
            if to not in TRANSITIONS.get(c["state"], ()):
                raise StoreError(f"illegal transition {c['state']} -> {to}")
            if to == "ready":
                self._require_green(db, c)
            db.execute("UPDATE candidates SET state=?, version=version+1, updated_at=? WHERE id=?", (to, now, cid))
            self._audit(db, c, actor, "transition", {"from": c["state"], "to": to}, now)
            return {"state": to, "version": version + 1}

    @staticmethod
    def _require_green(db: sqlite3.Connection, c: sqlite3.Row) -> None:
        rows = db.execute("SELECT status FROM results WHERE candidate_id=? AND revision=?", (c["id"], c["revision"])).fetchall()
        if not rows or any(r["status"] != "passed" for r in rows):
            raise StoreError("candidate is not green for its current revision")

    # ---- revisions and evidence -----------------------------------------------------------------------------------
    def new_revision(self, cid: str, *, fencing: int, version: int, dev_sha: str, candidate_sha: str, now: float) -> int:
        """Start the next sequential revision of the SAME candidate (e.g. after a repair). SHAs are unique per candidate."""
        with self._tx() as db:
            c = self._guard(db, cid, fencing, version, now)
            if c["state"] not in ("snapshotting", "repair-required"):
                raise StoreError(f"cannot start a revision from {c['state']}")
            rev = c["revision"] + 1
            try:
                db.execute("INSERT INTO revisions(candidate_id,revision,dev_sha,candidate_sha,created_at) VALUES(?,?,?,?,?)", (cid, rev, dev_sha, candidate_sha, now))
            except sqlite3.IntegrityError as e:
                raise StoreError("revision SHA must be unique within the candidate") from e
            db.execute("UPDATE candidates SET revision=?, dev_sha=?, candidate_sha=?, version=version+1, updated_at=? WHERE id=?", (rev, dev_sha, candidate_sha, now, cid))
            self._audit(db, c, "owner", "revision", {"revision": rev, "candidateSha": candidate_sha}, now)
            return rev

    def record_result(self, cid: str, *, revision: int, run_id: str, status: str, evidence: Any, fencing: int, now: float) -> None:
        """Immutable evidence. A result for any revision but the current one is refused, so an obsolete test cannot turn the candidate green."""
        with self._tx() as db:
            c = self._guard(db, cid, fencing, None, now)
            if revision != c["revision"]:
                raise StoreError(f"obsolete revision {revision}; current is {c['revision']}")
            if db.execute("SELECT 1 FROM results WHERE run_id=?", (run_id,)).fetchone():
                raise StoreError("evidence is immutable; run id already recorded")
            db.execute("INSERT INTO results(run_id,candidate_id,revision,status,evidence,at) VALUES(?,?,?,?,?,?)", (run_id, cid, revision, status, json.dumps(evidence, sort_keys=True), now))
            self._audit(db, c, "owner", "result", {"runId": run_id, "revision": revision, "status": status}, now)

    def record_promotion(self, cid: str, *, receipt_id: str, body: Any, fencing: int, now: float) -> dict[str, Any]:
        """Idempotent: replaying the same receipt id returns it instead of promoting twice."""
        with self._tx() as db:
            c = self._get(db, cid)
            seen = db.execute("SELECT * FROM receipts WHERE receipt_id=?", (receipt_id,)).fetchone()
            if seen:
                return {"receiptId": receipt_id, "replayed": True}
            self._guard(db, cid, fencing, None, now)
            if c["state"] not in ("promoting", "activating"):
                raise StoreError(f"cannot record a promotion from {c['state']}")
            db.execute("INSERT INTO receipts(receipt_id,candidate_id,body,at) VALUES(?,?,?,?)", (receipt_id, cid, json.dumps(body, sort_keys=True), now))
            self._audit(db, c, "owner", "promotion-receipt", {"receiptId": receipt_id}, now)
            return {"receiptId": receipt_id, "replayed": False}

    # ---- recovery and operator actions ----------------------------------------------------------------------------
    def stale_candidates(self, *, now: float) -> list[dict[str, Any]]:
        """Nonterminal candidates whose lease has lapsed (or never existed): the startup reconciliation worklist."""
        with self._tx() as db:
            rows = db.execute("SELECT * FROM candidates WHERE state NOT IN ('promoted','abandoned','failed','canceled') AND (lease_expires IS NULL OR lease_expires <= ?)", (now,)).fetchall()
            return [dict(r) for r in rows]

    def end(self, cid: str, to: str, *, actor: str, reason: str, now: float) -> None:
        """Operator cancel/abandon/fail. Bumps the fencing token so any stale holder is fenced out, and is audited."""
        if to not in ("abandoned", "canceled", "failed"):
            raise StoreError("operator end state must be abandoned, canceled or failed")
        with self._tx() as db:
            c = self._get(db, cid)
            if c["state"] in TERMINAL:
                return
            db.execute("UPDATE candidates SET state=?, version=version+1, fencing=fencing+1, owner=NULL, lease_expires=NULL, updated_at=? WHERE id=?", (to, now, cid))
            self._audit(db, c, actor, "end", {"to": to, "reason": reason, "from": c["state"]}, now)

    def get(self, cid: str) -> dict[str, Any]:
        with self._tx() as db:
            return dict(self._get(db, cid))

    def active(self, project_id: str) -> dict[str, Any] | None:
        with self._tx() as db:
            row = db.execute("SELECT * FROM candidates WHERE project_id=? AND state NOT IN ('promoted','abandoned','failed','canceled')", (project_id,)).fetchone()
            return dict(row) if row else None

    def audit_log(self, project_id: str) -> list[dict[str, Any]]:
        with self._tx() as db:
            return [dict(r) for r in db.execute("SELECT * FROM audit WHERE project_id=? ORDER BY seq", (project_id,)).fetchall()]
